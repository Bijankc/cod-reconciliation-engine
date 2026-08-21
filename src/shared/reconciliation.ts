/**
 * The reconciliation ladder — Decision 3.
 *
 * ONE pure function, first-match-wins, TOTAL over every (status x money)
 * combination. The ledger records what happened; this function interprets it.
 * It never clamps, never mutates, and never returns null.
 *
 * Proof of totality: `npm run verify:ladder` enumerates all 4 statuses x 5 money
 * relations and asserts every cell resolves to exactly one value.
 */

import {
  type DiscrepancyReason,
  type OrderStatus,
  type ReconciliationStatus,
} from "./constants.ts";

export interface ReconciliationOutcome {
  reconciliation_status: ReconciliationStatus;
  /** Non-null if and only if reconciliation_status === "DISCREPANCY". */
  discrepancy_reason: DiscrepancyReason | null;
}

/**
 * Rung 1's reason, resolved first-match-wins in the same order the DISCREPANCY
 * conditions are listed. A RETURNED order holding any cash outranks an
 * overpayment: recovering money from the courier is the more urgent call.
 */
function discrepancyReason(
  status: OrderStatus,
  collected: number,
  codAmount: number,
): DiscrepancyReason | null {
  if (status === "RETURNED" && collected > 0) return "RETURNED_WITH_PAYMENT";
  if (status === "DELIVERED" && collected < codAmount) return "DELIVERED_UNDERPAID";
  if (collected > codAmount) return "OVERPAID";
  return null;
}

export function reconcile(
  status: OrderStatus,
  collected: number,
  codAmount: number,
): ReconciliationOutcome {
  // Rung 1 — DISCREPANCY. Any money-truth that contradicts the lifecycle.
  const reason = discrepancyReason(status, collected, codAmount);
  if (reason !== null) {
    return { reconciliation_status: "DISCREPANCY", discrepancy_reason: reason };
  }

  // Rung 2 — FULLY_COLLECTED. Delivered and exactly settled.
  // `==` not `>=`: overpayment was already caught by rung 1 (Decision 4).
  if (status === "DELIVERED" && collected === codAmount) {
    return { reconciliation_status: "FULLY_COLLECTED", discrepancy_reason: null };
  }

  // Rung 3 — RETURNED_UNPAID. The clean return: goods back, no money moved.
  if (status === "RETURNED" && collected === 0) {
    return { reconciliation_status: "RETURNED_UNPAID", discrepancy_reason: null };
  }

  // Rung 4 — AWAITING_CONFIRMATION. Paid in full, delivery not yet confirmed.
  // Benign in-progress state, NOT a flag. Guarded on the two non-terminal
  // statuses rather than DISPATCHED alone: PENDING + fully-collected is
  // unreachable through the state machine, but leaving it unguarded put a hole
  // in the ladder. See README decision log, "closing the ladder's one hole".
  if ((status === "DISPATCHED" || status === "PENDING") && collected === codAmount) {
    return { reconciliation_status: "AWAITING_CONFIRMATION", discrepancy_reason: null };
  }

  // Rung 5 — PARTIALLY_COLLECTED. Some money, not all of it.
  if (collected > 0 && collected < codAmount) {
    return { reconciliation_status: "PARTIALLY_COLLECTED", discrepancy_reason: null };
  }

  // Rung 6 — PENDING. Total catch-all. Only `collected === 0` can reach it;
  // verify:ladder proves no other input survives rungs 1-5.
  return { reconciliation_status: "PENDING", discrepancy_reason: null };
}
