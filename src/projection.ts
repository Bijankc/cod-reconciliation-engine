/**
 * The projection — Zone 2 (CP) writing into Zone 3 (AP).
 *
 * This file is the whole CQRS seam. The Durable Object owns money-truth; the
 * `orders` row is a COPY of that truth, kept for one reason only: a dashboard
 * listing 200 orders cannot make 200 Durable Object round trips. Everything the
 * projection writes is derived, replaceable, and rebuildable from the ledger.
 *
 * The hazard the projection has to survive is that its writes are not ordered.
 * Two events for one order are serialised inside the DO, but the two consumer
 * invocations that carry their results into D1 race freely — different queue
 * batches, possibly different isolates, no coordination between them. Without a
 * guard, the loser of that race writes an OLDER ledger state over a newer one
 * and the merchant watches the collected total go backwards.
 *
 * The guard is a compare-and-set on the DO's monotonic version, expressed as a
 * WHERE clause:
 *
 *     UPDATE orders SET ... WHERE order_id = ? AND projection_version < ?
 *
 * One statement, so it is atomic without a transaction: the comparison and the
 * write cannot be split by another writer. A stale projection matches zero rows
 * and vanishes, which is the correct outcome, not an error — the newer state it
 * lost to already contains everything it was carrying, because the DO recomputes
 * the ENTIRE state on every event rather than emitting deltas. That is what
 * makes a dropped projection write harmless and this design safe under
 * at-least-once delivery: the projection is idempotent and last-writer-wins,
 * where "last" means highest version rather than whoever arrived last.
 */

import type { Env } from "./env.d.ts";
import type { LedgerState } from "./shared/types.ts";

export type ProjectionResult = "written" | "stale";

/**
 * Copy one ledger state into the read model, unless the read model already
 * holds something newer.
 *
 * `last_event_at` is the ledger's `last_occurred_at` — the courier's clock on
 * the last applied state transition — and NOT the consumer's wall clock. Every
 * column this writes has to be a pure function of DO state, or the version
 * guard would be guarding only some of the row and a dropped write would leave
 * the rest behind at a value nothing can reproduce.
 */
export async function projectToD1(state: LedgerState, env: Env): Promise<ProjectionResult> {
  const result = await env.DB.prepare(
    `UPDATE orders
        SET current_status        = ?,
            amount_collected      = ?,
            reconciliation_status = ?,
            discrepancy_reason    = ?,
            last_event_at         = ?,
            projection_version    = ?
      WHERE order_id = ?
        AND projection_version < ?`,
  )
    .bind(
      state.status,
      state.amount_collected,
      state.reconciliation_status,
      state.discrepancy_reason,
      state.last_occurred_at,
      state.version,
      state.order_id,
      state.version,
    )
    .run();

  // No rows changed means the guard fired: the row is already at this version
  // (a redelivery) or past it (a newer projection won). Both are correct and
  // neither is retryable, so this is reported, not thrown.
  return (result.meta.changes ?? 0) > 0 ? "written" : "stale";
}
