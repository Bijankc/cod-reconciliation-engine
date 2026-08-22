/**
 * Queue consumer — the async half of Zone 1.
 *
 * Per message, in this order and for these reasons:
 *
 *   1. R2 audit write FIRST, always. The audit log records everything received,
 *      valid or orphaned, before any decision is made about it. Writing it first
 *      means a crash anywhere later still leaves evidence of what arrived.
 *   2. Confirm the order exists in D1. That same read supplies cod_amount, so
 *      the safety check and the data fetch are one round trip (Decision 5).
 *   3. Unknown order -> orphan_events + ack. Never a Durable Object call: a DO is
 *      addressed BY NAME, so a bad order_id would not fail, it would silently
 *      spawn a phantom ledger holding real money.
 *   4. Otherwise record the event against the order.
 *
 * PHASE 3: step 4 calls the OrderLedger Durable Object and records its verdict.
 * PHASE 4: steps 5-6 carry that verdict into the read model — the version-guarded
 * projection of the ledger state, then the timeline row for the event itself.
 *
 * Projection BEFORE timeline row, deliberately. Both writes are idempotent and
 * either order converges under retry, so the tie is broken on what a crash in
 * between looks like to a merchant. Projection first leaves a correct total with
 * one event missing from the timeline. Timeline first leaves a visible
 * "payment_collected — applied" sitting above a total that does not include it,
 * which is a system contradicting itself about money. The recoverable state
 * should be the one that does not look like a bug.
 *
 * Failure posture: transient failures (a D1 or R2 hiccup) throw, so the Queue
 * retries with backoff — at-least-once delivery is the whole point, and the DO's
 * event_id dedup is what makes reprocessing safe. Each message is acked or
 * retried INDIVIDUALLY so one bad message cannot drag its batch back through
 * work that already succeeded.
 */

import type { Env } from "./env.d.ts";
import type { QueuedCourierEvent } from "./shared/types.ts";
import { projectToD1 } from "./projection.ts";

/** R2 key layout, per spec 7.3. Immutable, write-once. */
export function auditKey(orderId: string, eventId: string): string {
  return `events/${orderId}/${eventId}.json`;
}

interface OrderLookup {
  order_id: string;
  cod_amount: number;
}

async function handleMessage(event: QueuedCourierEvent, env: Env): Promise<string> {
  const receivedAt = new Date().toISOString();
  const key = auditKey(event.order_id, event.event_id);

  // 1. Audit first — the verbatim bytes the courier sent us.
  await env.AUDIT.put(key, event.raw, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      order_id: event.order_id,
      event_id: event.event_id,
      type: event.type,
      received_at: receivedAt,
    },
  });

  // 2. Existence check + cod_amount in a single read.
  const order = await env.DB.prepare(`SELECT order_id, cod_amount FROM orders WHERE order_id = ?`)
    .bind(event.order_id)
    .first<OrderLookup>();

  // 3. Orphan path — terminal, queryable, and never routed to a DO.
  if (order === null) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO orphan_events
         (event_id, order_id, type, amount, occurred_at, received_at, courier_id, raw_r2_key, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'UNKNOWN_ORDER')`,
    )
      .bind(
        event.event_id,
        event.order_id,
        event.type,
        event.amount ?? null,
        event.occurred_at,
        receivedAt,
        event.courier_id ?? null,
        key,
      )
      .run();

    console.log(`[orphan] ${event.event_id} -> unknown order ${event.order_id}`);
    return "orphan";
  }

  // 4. Route to the ledger. idFromName is deterministic, so every event for this
  //    order reaches the SAME single-threaded instance — that is what makes the
  //    lost update impossible. Reached only after the existence check above:
  //    naming a DO is what brings it into being, so an unverified order_id must
  //    never get this far.
  const id = env.ORDER_LEDGER.idFromName(event.order_id);
  const ledger = env.ORDER_LEDGER.get(id);
  const result = await ledger.applyEvent(event, order.cod_amount);

  // 5. Project the ledger state into the read model. The version guard makes
  //    this safe to lose a race: a stale write matches no rows and disappears.
  const projection = await projectToD1(result.state, env);

  // 6. Record the event with the ledger's REAL verdict, plus everything the
  //    ledger now knows about this event_id, in one batch.
  //
  //    ON CONFLICT rather than INSERT OR IGNORE: at-least-once means the row may
  //    already exist, and when it does there are two things worth refreshing.
  //    `delivery_count` comes from the DO's count rather than being incremented
  //    here, so replaying this write can never inflate it. `outcome` is adopted
  //    from the ledger's standing verdict, which makes the row self-healing —
  //    if the buffered -> applied revision below was ever lost to a crash, the
  //    next redelivery of that event silently repairs it.
  const writes = [
    env.DB.prepare(
      `INSERT INTO order_events
         (event_id, order_id, type, amount, occurred_at, received_at,
          outcome, delivery_count, courier_id, raw_r2_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         delivery_count = excluded.delivery_count,
         outcome        = excluded.outcome`,
    ).bind(
      event.event_id,
      event.order_id,
      event.type,
      event.amount ?? null,
      event.occurred_at,
      receivedAt,
      result.outcome,
      result.deliveries,
      event.courier_id ?? null,
      key,
    ),

    // Events that drained out of the pending buffer because of this one. Their
    // rows still say `buffered` from when they arrived early; the ledger has
    // since applied them, so the timeline has to catch up or it will keep
    // showing a held event that is actually settled. Guarded on the old value
    // so this can never walk an `anomaly` backwards.
    ...result.drained.map((eventId) =>
      env.DB.prepare(
        `UPDATE order_events SET outcome = 'applied'
          WHERE event_id = ? AND outcome = 'buffered'`,
      ).bind(eventId),
    ),
  ];

  await env.DB.batch(writes);

  console.log(
    `[${result.outcome}] ${event.type} ${event.event_id} order=${event.order_id} ` +
      `status=${result.state.status} collected=${result.state.amount_collected}/${result.state.cod_amount} ` +
      `recon=${result.state.reconciliation_status} v=${result.state.version} ` +
      `projection=${projection}` +
      (result.deliveries > 1 ? ` delivery#${result.deliveries}` : "") +
      (result.drained.length > 0 ? ` drained=${result.drained.join(",")}` : ""),
  );
  return result.outcome;
}

export async function consumeBatch(
  batch: MessageBatch<QueuedCourierEvent>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await handleMessage(message.body, env);
      message.ack();
    } catch (error) {
      // Transient by assumption: retry with backoff, and after max_retries the
      // DLQ catches it rather than letting it block the pipeline.
      console.error(`[retry] ${message.body?.event_id ?? "?"}`, error);
      message.retry();
    }
  }
}
