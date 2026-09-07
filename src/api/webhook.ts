/**
 * POST /webhook/courier — the ingress of Zone 1 (async, disorder-tolerant).
 *
 * Does the minimum that must happen synchronously: authenticate, validate,
 * enqueue, and return 202. Everything expensive — the audit write, the ledger
 * call, the D1 projection — happens on the consumer side. A courier waiting on
 * our database is a courier that times out and retries, which is how duplicate
 * events get made in the first place.
 *
 * Malformed events are rejected with 400 and NEVER enqueued: the queue is for
 * events we have already decided are well-formed, so a poisonous payload can
 * never occupy retry budget.
 */

import type { Env } from "../env.d.ts";
import { json, badRequest, validationFailed } from "../shared/http.ts";
import { validateCourierEvent } from "../shared/validate-event.ts";

/**
 * Length-independent comparison, so the response time of this endpoint says
 * nothing about how much of the secret a caller guessed correctly.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

export async function courierWebhook(request: Request, env: Env): Promise<Response> {
  const expected = env.COURIER_SHARED_SECRET;
  if (!expected) {
    // Fail closed. An unset secret must never mean "allow everyone".
    console.error("COURIER_SHARED_SECRET is not configured");
    return json({ error: "misconfigured" }, 500);
  }

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (presented === null || !secretsMatch(presented, expected)) {
    return json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  }

  // Read the body as text first: the audit log stores the payload verbatim, so
  // unknown fields from a future schema version survive the round trip byte for
  // byte.
  const raw = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const result = validateCourierEvent(body);
  if (!result.ok) return validationFailed(result.errors);

  await env.COURIER_QUEUE.send({ ...result.event, raw });

  return json(
    { accepted: true, event_id: result.event.event_id, order_id: result.event.order_id },
    202,
  );
}
