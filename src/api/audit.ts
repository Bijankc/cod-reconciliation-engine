/**
 * GET /api/orders/:id/audit — the immutable record of what actually arrived.
 *
 * R2 holds the verbatim bytes of every courier payload, written before anything
 * is decided about it (consumer step 1). That makes this endpoint materially
 * different from the D1 timeline sitting next to it, in two ways worth saying
 * plainly because they are the reason the audit log exists at all:
 *
 *   1. It is WIDER. The consumer writes to R2 before it knows whether the order
 *      exists, so an order created after its events arrived has orphaned
 *      payloads in R2 that the ledger never saw and the timeline cannot show.
 *   2. It is UNINTERPRETED. The timeline shows the ledger's verdict; this shows
 *      the payload the verdict was formed from, including any fields a future
 *      schema version added that this build does not yet understand
 *      (§9, additive-only evolution).
 *
 * "Different data, different shape": a listing of opaque blobs addressed by key
 * is exactly what an object store is for, and exactly what a relational read
 * model is bad at.
 */

import type { Env } from "../env.d.ts";
import { auditKey } from "../consumer.ts";
import { json, notFound } from "../shared/http.ts";

/** One R2 object as the dashboard needs it — a reference, not a payload. */
interface AuditRef {
  key: string;
  event_id: string;
  size: number;
  uploaded: string;
  type: string | null;
  received_at: string | null;
}

export async function getOrderAudit(
  orderId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  // Same rule as everywhere else: the order must exist in D1 before we build a
  // key prefix out of a caller-supplied string.
  const exists = await env.DB.prepare(`SELECT 1 AS ok FROM orders WHERE order_id = ?`)
    .bind(orderId)
    .first<{ ok: number }>();
  if (exists === null) return notFound("order", orderId);

  const eventId = new URL(request.url).searchParams.get("event_id");

  // ?event_id= — hand back the stored bytes untouched. Not re-serialised, not
  // reshaped: the point of the audit log is that this is a byte-for-byte replay
  // of what the courier sent.
  if (eventId !== null) {
    const object = await env.AUDIT.get(auditKey(orderId, eventId));
    if (object === null) return notFound("audit_object", eventId);

    return new Response(object.body, {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        // Immutable by construction; the ETag is the integrity claim.
        etag: object.httpEtag,
      },
    });
  }

  const listing = await env.AUDIT.list({
    prefix: `events/${orderId}/`,
    include: ["customMetadata"],
  });

  const objects: AuditRef[] = listing.objects.map((object) => ({
    key: object.key,
    event_id: object.customMetadata?.event_id ?? object.key.split("/").pop()!.replace(/\.json$/, ""),
    size: object.size,
    uploaded: object.uploaded.toISOString(),
    type: object.customMetadata?.type ?? null,
    received_at: object.customMetadata?.received_at ?? null,
  }));

  // Newest first, to match the timeline's ordering on the detail view.
  objects.sort((a, b) => b.uploaded.localeCompare(a.uploaded));

  return json({
    order_id: orderId,
    objects,
    count: objects.length,
    truncated: listing.truncated,
    source: "r2_audit_log",
    consistency: "immutable",
    note: "Raw payloads as received, before validation of order existence. May include events the ledger never saw.",
  });
}
