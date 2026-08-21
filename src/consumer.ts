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
 * The 'received' placeholder Phase 2 wrote is no longer reachable on this path.
 *
 * Failure posture: transient failures (a D1 or R2 hiccup) throw, so the Queue
 * retries with backoff — at-least-once delivery is the whole point, and the DO's
 * event_id dedup is what makes reprocessing safe. Each message is acked or
 * retried INDIVIDUALLY so one bad message cannot drag its batch back through
 * work that already succeeded.
 */

import type { Env } from "./env.d.ts";
import type { QueuedCourierEvent } from "./shared/types.ts";

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

  // 5. Record the event with the ledger's REAL verdict — applied, duplicate,
  //    buffered or anomaly. Written once, in a single insert; 'received' is
  //    never written on this path, so a row can never be left holding a
  //    verdict-pending placeholder after the ledger has ruled.
  //    INSERT OR IGNORE because at-least-once means this may be a redelivery,
  //    and event_id is the primary key.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO order_events
       (event_id, order_id, type, amount, occurred_at, received_at, outcome, courier_id, raw_r2_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      event.event_id,
      event.order_id,
      event.type,
      event.amount ?? null,
      event.occurred_at,
      receivedAt,
      result.outcome,
      event.courier_id ?? null,
      key,
    )
    .run();

  console.log(
    `[${result.outcome}] ${event.type} ${event.event_id} order=${event.order_id} ` +
      `status=${result.state.status} collected=${result.state.amount_collected}/${result.state.cod_amount} ` +
      `recon=${result.state.reconciliation_status} v=${result.state.version}` +
      (result.drained > 0 ? ` drained=${result.drained}` : ""),
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
