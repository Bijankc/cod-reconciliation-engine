/**
 * COD Reconciliation Engine — Worker entry point and router.
 *
 * Async AP ingestion -> CP ledger -> eventually-consistent reads.
 *
 * PHASE 1: the merchant order API is live against D1. The webhook and queue
 * consumer arrive in Phase 2, the ledger in Phase 3, the projection in Phase 4.
 */

import type { Env } from "./env.d.ts";
import type { CourierEvent } from "./shared/types.ts";
import {
  CURRENCY,
  CURRENT_SCHEMA_VERSION,
  EVENT_TYPES,
  RECONCILIATION_STATUSES,
} from "./shared/constants.ts";
import { json, notFound, methodNotAllowed } from "./shared/http.ts";
import { createOrder, listOrders, getOrder } from "./api/orders.ts";

export { OrderLedger } from "./durable-objects/order-ledger.ts";

function health(env: Env): Response {
  return json({
    service: "cod-reconciliation-engine",
    phase: 1,
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

  const orderDetail = /^\/api\/orders\/([^/]+)$/.exec(path);
  if (orderDetail) {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return getOrder(decodeURIComponent(orderDetail[1]!), env);
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

  async queue(batch: MessageBatch<CourierEvent>, _env: Env): Promise<void> {
    // Phase 2 wires this up: R2 audit write, order-existence check, DO call,
    // D1 projection. For now acking keeps nothing accumulating in the queue.
    for (const message of batch.messages) {
      console.log(`[phase1] received event ${message.body?.event_id ?? "?"}`);
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, CourierEvent>;
