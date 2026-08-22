/**
 * GET /api/dead-letters — the poison pile, as a queryable list.
 *
 * Small on purpose. The value of this endpoint is not the data shape; it is that
 * a dead-lettered message is something you can point at during a demo and query
 * after an incident, rather than a log line that scrolled away.
 */

import type { Env } from "../env.d.ts";
import { json } from "../shared/http.ts";

interface DeadLetterRow {
  event_id: string;
  order_id: string | null;
  type: string | null;
  amount: number | null;
  occurred_at: string | null;
  courier_id: string | null;
  dead_lettered_at: string;
  dlq_attempts: number | null;
  raw: string | null;
  reason: string;
}

export async function listDeadLetters(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM dead_letters ORDER BY dead_lettered_at DESC LIMIT 100`,
  ).all<DeadLetterRow>();

  return json({
    dead_letters: results,
    count: results.length,
    source: "d1_dead_letters",
    consistency: "eventual",
    note: "Messages the consumer failed on for every retry, then moved to courier-events-dlq.",
  });
}
