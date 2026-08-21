/**
 * COD Reconciliation Engine — Worker entry point.
 *
 * Async AP ingestion -> CP ledger -> eventually-consistent reads.
 *
 * PHASE 0: the pipeline exists and every binding is wired, but the routes are
 * stubs. Phase 1 brings the order API, Phase 2 the webhook and consumer,
 * Phase 3 the ledger, Phase 4 the projection.
 */

import type { Env } from "./env.d.ts";
import type { CourierEvent } from "./shared/types.ts";
import {
  CURRENCY,
  CURRENT_SCHEMA_VERSION,
  EVENT_TYPES,
  RECONCILIATION_STATUSES,
} from "./shared/constants.ts";

export { OrderLedger } from "./durable-objects/order-ledger.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        service: "cod-reconciliation-engine",
        phase: 0,
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

    return Response.json({ error: "not_found", path: url.pathname }, { status: 404 });
  },

  async queue(batch: MessageBatch<CourierEvent>, _env: Env): Promise<void> {
    // Phase 2 wires this up: R2 audit write, order-existence check, DO call,
    // D1 projection. Phase 0 acks so nothing accumulates in the queue.
    for (const message of batch.messages) {
      console.log(`[phase0] received event ${message.body?.event_id ?? "?"}`);
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, CourierEvent>;
