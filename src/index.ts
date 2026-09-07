/**
 * COD Reconciliation Engine — Worker entry point and router.
 *
 * Async AP ingestion -> CP ledger -> eventually-consistent reads.
 *
 * PHASE 4: all three zones are now wired end to end. The webhook validates and
 * enqueues (AP ingestion), the consumer audits to D1 and drives the OrderLedger
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
  DISCREPANCY_REASON_TEXT,
  EVENT_OUTCOMES,
  EVENT_TYPES,
  FLAGGED_RECONCILIATION_STATUSES,
  ORDER_STATUSES,
  RECONCILIATION_STATUSES,
} from "./shared/constants.ts";
import { json, notFound, methodNotAllowed } from "./shared/http.ts";
import { handlePreflight, withCors } from "./shared/cors.ts";
import { createOrder, listOrders, getOrder } from "./api/orders.ts";
import { getOrderAudit } from "./api/audit.ts";
import { courierWebhook } from "./api/webhook.ts";
import { consumeBatch } from "./consumer.ts";
import { consumeDeadLetters } from "./dead-letters.ts";
import { listDeadLetters } from "./api/dead-letters.ts";

export { OrderLedger } from "./durable-objects/order-ledger.ts";

/**
 * Health, and the frontend's vocabulary in the same payload.
 *
 * `src/shared/constants.ts` is the single source of truth for every enum and
 * unit in the system, and its own rule is that nothing may re-declare them. The
 * frontend is static — served by Pages, no build step — so it cannot import a
 * TypeScript module. Rather than break the rule with a hand-copied currency
 * symbol and a hand-copied list of statuses that drift the first time either
 * changes, the frontend FETCHES its vocabulary from here at boot. The rule
 * survives the language boundary by crossing it over HTTP.
 */
function health(env: Env): Response {
  return json({
    service: "cod-reconciliation-engine",
    phase: 6,
    status: "ok",
    currency: CURRENCY,
    schema_version: CURRENT_SCHEMA_VERSION,
    event_types: EVENT_TYPES,
    event_outcomes: EVENT_OUTCOMES,
    order_statuses: ORDER_STATUSES,
    reconciliation_statuses: RECONCILIATION_STATUSES,
    flagged_reconciliation_statuses: FLAGGED_RECONCILIATION_STATUSES,
    discrepancy_reason_text: DISCREPANCY_REASON_TEXT,
    bindings: {
      queue: Boolean(env.COURIER_QUEUE),
      durable_object: Boolean(env.ORDER_LEDGER),
      d1: Boolean(env.DB),
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

  if (path === "/api/dead-letters") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return listDeadLetters(env);
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
    // Preflight first: ahead of the router, ahead of auth. An OPTIONS request
    // the browser generated on its own must never meet a handler that expects
    // POST or a bearer token.
    const preflight = handlePreflight(request, env);
    if (preflight !== null) return preflight;

    let response: Response;
    try {
      response = await route(request, env);
    } catch (error) {
      // Never leak an internal error shape to a caller; the log carries detail.
      console.error("unhandled error", error);
      response = json({ error: "internal_error" }, 500);
    }

    // Errors get CORS headers too. A 500 the browser discards for CORS reasons
    // shows up in devtools as a CORS problem, sending the next hour of
    // debugging in entirely the wrong direction.
    return withCors(response, request, env);
  },

  /**
   * One handler, two queues. `batch.queue` is what distinguishes them, and the
   * two paths have deliberately OPPOSITE failure postures: the main consumer
   * throws so the queue retries, while the dead-letter consumer acks
   * unconditionally because there is nowhere left to send a message that fails
   * at the end of the line.
   */
  async queue(batch: MessageBatch<QueuedCourierEvent>, env: Env): Promise<void> {
    if (batch.queue === "courier-events-dlq") {
      await consumeDeadLetters(batch, env);
      return;
    }
    await consumeBatch(batch, env);
  },
} satisfies ExportedHandler<Env, QueuedCourierEvent>;
