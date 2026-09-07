/**
 * GET /api/orders/:id/audit — the immutable record of what actually arrived.
 *
 * The `audit` table holds the verbatim bytes of every courier payload, written
 * before anything is decided about it (consumer step 1). That makes this
 * endpoint materially different from the `order_events` timeline sitting next to
 * it, in two ways worth saying plainly because they are the reason the audit log
 * exists at all:
 *
 *   1. It is WIDER. The consumer writes the payload before it knows whether the
 *      order exists, so an order created after its events arrived has orphaned
 *      payloads here that the ledger never saw and the timeline cannot show.
 *   2. It is UNINTERPRETED. The timeline shows the ledger's verdict; this shows
 *      the payload the verdict was formed from, including any fields a future
 *      schema version added that this build does not yet understand
 *      (§9, additive-only evolution).
 *
 * Both tables live in D1, and they are separate tables for that reason: one
 * records what we concluded, the other records what we were sent. The audit
 * table is insert-only — the consumer never updates a row — so "immutable" is a
 * property of how it is written, not of the store it is written to.
 */

import type { Env } from "../env.d.ts";
import { json, notFound } from "../shared/http.ts";

/** One audit row as the dashboard needs it — a reference, not a payload. */
interface AuditRef {
  event_id: string;
  bytes: number;
  received_at: string;
}

interface AuditPayload {
  payload: string;
}

export async function getOrderAudit(
  orderId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  // Same rule as everywhere else: the order must exist in D1 before we go
  // looking for audit rows under a caller-supplied string.
  const exists = await env.DB.prepare(`SELECT 1 AS ok FROM orders WHERE order_id = ?`)
    .bind(orderId)
    .first<{ ok: number }>();
  if (exists === null) return notFound("order", orderId);

  const eventId = new URL(request.url).searchParams.get("event_id");

  // ?event_id= — hand back the stored bytes untouched. Not re-serialised, not
  // reshaped: the point of the audit log is that this is a byte-for-byte replay
  // of what the courier sent.
  if (eventId !== null) {
    const row = await env.DB.prepare(
      `SELECT payload FROM audit WHERE order_id = ? AND event_id = ?`,
    )
      .bind(orderId, eventId)
      .first<AuditPayload>();
    if (row === null) return notFound("audit_payload", eventId);

    return new Response(row.payload, {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  }

  // Newest first, to match the timeline's ordering on the detail view. The byte
  // count is what tells a reader the row holds something without fetching it.
  const listing = await env.DB.prepare(
    `SELECT event_id, length(payload) AS bytes, received_at
       FROM audit
      WHERE order_id = ?
      ORDER BY received_at DESC`,
  )
    .bind(orderId)
    .all<AuditRef>();

  const objects = listing.results ?? [];

  return json({
    order_id: orderId,
    objects,
    count: objects.length,
    source: "d1_audit_log",
    consistency: "immutable",
    note: "Raw payloads as received, before validation of order existence. May include events the ledger never saw.",
  });
}
