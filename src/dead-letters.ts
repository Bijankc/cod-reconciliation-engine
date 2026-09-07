/**
 * The dead-letter consumer — where messages go when retrying stops helping.
 *
 * `courier-events` retries a failing message up to `max_retries` with backoff.
 * That is the right response to a TRANSIENT failure: a D1 hiccup, a cold DO, a
 * momentary DO overload. It is the wrong response to a message that will fail
 * identically forever, and the difference between those two cases is invisible
 * from inside a single attempt.
 *
 * So the queue makes the distinction by exhaustion: anything still failing after
 * five attempts is treated as poison and moved to `courier-events-dlq`. That
 * move is what protects the pipeline. Without it, a permanently-failing message
 * is retried forever, consuming the retry budget and — in a queue that preserves
 * order — blocking everything behind it. **The DLQ's job is not to fix the bad
 * message. It is to get it out of the way of the good ones**, while keeping it
 * where a human can find it.
 *
 * This consumer's own job is narrow: make the dead letter QUERYABLE. A message
 * that lands in a queue nobody reads expires after the 24-hour retention window,
 * which is a slower way of losing it. A row in D1 outlives that.
 *
 * FAILURE POSTURE. This consumer acks unconditionally, and that is deliberate
 * and the opposite of the main consumer's posture. There is no third queue to
 * fall through to, so a message that fails here has nowhere else to go —
 * retrying it would only burn the retention window before dropping it anyway.
 * The write is recorded, the failure is logged loudly, and the message is
 * released. This is the end of the line, and the end of the line should not be
 * a loop.
 */

import type { Env } from "./env.d.ts";
import type { QueuedCourierEvent } from "./shared/types.ts";

async function recordDeadLetter(
  message: Message<QueuedCourierEvent>,
  env: Env,
): Promise<void> {
  const event = message.body;

  await env.DB.prepare(
    // OR REPLACE, not OR IGNORE: if the same event_id somehow dead-letters
    // twice, the later record is the more useful one to keep.
    `INSERT OR REPLACE INTO dead_letters
       (event_id, order_id, type, amount, occurred_at, courier_id,
        dead_lettered_at, dlq_attempts, raw, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONSUMER_FAILED')`,
  )
    .bind(
      event?.event_id ?? `unparseable_${message.id}`,
      event?.order_id ?? null,
      event?.type ?? null,
      event?.amount ?? null,
      event?.occurred_at ?? null,
      event?.courier_id ?? null,
      new Date().toISOString(),
      // Queues restarts the attempt counter when a message moves to the DLQ, so
      // this is THIS consumer's attempt count — not how many times the main
      // consumer failed. Recorded for what it is, and no more.
      message.attempts,
      event?.raw ?? null,
    )
    .run();
}

export async function consumeDeadLetters(
  batch: MessageBatch<QueuedCourierEvent>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await recordDeadLetter(message, env);
      console.error(
        `[dead-letter] ${message.body?.event_id ?? message.id} ` +
          `order=${message.body?.order_id ?? "?"} type=${message.body?.type ?? "?"} ` +
          `— exhausted retries on courier-events and was moved to the DLQ`,
      );
    } catch (error) {
      // Log and ack anyway. See the failure posture note above: there is nowhere
      // left to send this, so holding onto it only delays the loss.
      console.error(`[dead-letter] FAILED TO RECORD ${message.id}`, error);
    }
    message.ack();
  }
}
