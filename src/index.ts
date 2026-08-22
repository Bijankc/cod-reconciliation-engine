/**
 * COD Reconciliation Engine — Worker entry point and router.
 *
 * Async AP ingestion -> CP ledger -> eventually-consistent reads.
 *
 * PHASE 4: all three zones are now wired end to end. The webhook validates and
 * enqueues (AP ingestion), the consumer audits to R2 and drives the OrderLedger
 * Durable Object (CP), and the ledger's state is projected into D1 behind a
 * version guard for the dashboard to read (eventually consistent).
 *
 * Every read route names the zone that answered it. `?authoritative=true` on the
 * order detail route is the exception that proves the split: it reads the ledger
 * itself and reports how far the projection is trailing.
 */

import type { Env } from "./env.d.ts";
import type { QueuedCourierEvent } from "./shared/types.ts";
import {
  CURRENCY,
  CURRENT_SCHEMA_VERSION,
  EVENT_TYPES,
  RECONCILIATION_STATUSES,
} from "./shared/constants.ts";
import { json, notFound, methodNotAllowed } from "./shared/http.ts";
import { createOrder, listOrders, getOrder } from "./api/orders.ts";
import { getOrderAudit } from "./api/audit.ts";
import { courierWebhook } from "./api/webhook.ts";
import { consumeBatch } from "./consumer.ts";

export { OrderLedger } from "./durable-objects/order-ledger.ts";

function health(env: Env): Response {
  return json({
    service: "cod-reconciliation-engine",
    phase: 4,
    status: "ok",
    currency: CURRENCY.code,
    amount_unit: CURRENCY.label,
    schema_version: CURRENT_SCHEMA_VERSION,
    event_types: EVENT_TYPES,
    reconciliation_statuses: RECONCILIATION_STATUSES,
    bindings: {
      queue: Boolean(env.COURIER_QUEUE),
      durable_object: Boolean(env.ORDER_LEDGER),
      d1: Boolean(env.DB),
      r2: Boolean(env.AUDIT),
    },
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (path === "/" || path === "/health") {
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed(["GET"]);
    return health(env);
  }

  if (path === "/api/orders") {
    if (method === "POST") return createOrder(request, env);
    if (method === "GET") return listOrders(request, env);
    return methodNotAllowed(["GET", "POST"]);
  }

  if (path === "/webhook/courier") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    return courierWebhook(request, env);
  }

  const orderDetail = /^\/api\/orders\/([^/]+)$/.exec(path);
  if (orderDetail) {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    // Opt-in, because it costs a Durable Object round trip. The dashboard list
    // never pays it; a single order being inspected side by side does.
    const authoritative = url.searchParams.get("authoritative") === "true";
    return getOrder(decodeURIComponent(orderDetail[1]!), env, { authoritative });
  }

  const orderAudit = /^\/api\/orders\/([^/]+)\/audit$/.exec(path);
  if (orderAudit) {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return getOrderAudit(decodeURIComponent(orderAudit[1]!), request, env);
  }

  return notFound("route", url.pathname);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      // Never leak an internal error shape to a caller; the log carries detail.
      console.error("unhandled error", error);
      return json({ error: "internal_error" }, 500);
    }
  },

  async queue(batch: MessageBatch<QueuedCourierEvent>, env: Env): Promise<void> {
    await consumeBatch(batch, env);
  },
} satisfies ExportedHandler<Env, QueuedCourierEvent>;
