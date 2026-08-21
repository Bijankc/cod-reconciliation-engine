/**
 * Totality proof for the reconciliation ladder (Decision 3).
 *
 * Enumerates every (order status x money relation) combination and asserts:
 *   1. every cell resolves to a value in RECONCILIATION_STATUSES (never null),
 *   2. discrepancy_reason is non-null exactly when the status is DISCREPANCY,
 *   3. every one of the six values is actually reachable (no dead rung).
 *
 * Run: npm run verify:ladder
 */

import {
  ORDER_STATUSES,
  RECONCILIATION_STATUSES,
  type OrderStatus,
  type ReconciliationStatus,
} from "../src/shared/constants.ts";
import { reconcile } from "../src/shared/reconciliation.ts";

const COD = 1500;

/** Every distinct money relation to cod_amount, including the boundaries. */
const MONEY_CASES: { label: string; collected: number }[] = [
  { label: "collected == 0", collected: 0 },
  { label: "0 < collected < cod (just above 0)", collected: 1 },
  { label: "0 < collected < cod (midpoint)", collected: 750 },
  { label: "0 < collected < cod (just below cod)", collected: COD - 1 },
  { label: "collected == cod", collected: COD },
  { label: "collected > cod (just above)", collected: COD + 1 },
  { label: "collected > cod (double)", collected: COD * 2 },
];

const seen = new Set<ReconciliationStatus>();
const failures: string[] = [];
const rows: string[] = [];

for (const status of ORDER_STATUSES) {
  for (const money of MONEY_CASES) {
    const out = reconcile(status as OrderStatus, money.collected, COD);
    const cell = `${status.padEnd(10)} | ${String(money.collected).padStart(5)} / ${COD}`;

    if (out.reconciliation_status === undefined || out.reconciliation_status === null) {
      failures.push(`NULL FALLTHROUGH: ${cell}`);
      continue;
    }
    if (!(RECONCILIATION_STATUSES as readonly string[]).includes(out.reconciliation_status)) {
      failures.push(`UNKNOWN VALUE "${out.reconciliation_status}": ${cell}`);
      continue;
    }

    const isDiscrepancy = out.reconciliation_status === "DISCREPANCY";
    if (isDiscrepancy && out.discrepancy_reason === null) {
      failures.push(`DISCREPANCY WITHOUT REASON: ${cell}`);
    }
    if (!isDiscrepancy && out.discrepancy_reason !== null) {
      failures.push(`REASON ON NON-DISCREPANCY: ${cell} -> ${out.discrepancy_reason}`);
    }

    seen.add(out.reconciliation_status);
    rows.push(
      `  ${cell} -> ${out.reconciliation_status.padEnd(21)} ${out.discrepancy_reason ?? ""}`.trimEnd(),
    );
  }
}

console.log(`Reconciliation ladder — ${ORDER_STATUSES.length} statuses x ${MONEY_CASES.length} money cases = ${ORDER_STATUSES.length * MONEY_CASES.length} cells\n`);
console.log(rows.join("\n"));

const unreachable = RECONCILIATION_STATUSES.filter((s) => !seen.has(s));
if (unreachable.length > 0) {
  failures.push(`UNREACHABLE RUNG(S): ${unreachable.join(", ")}`);
}

console.log("");
if (failures.length > 0) {
  console.error("LADDER IS NOT TOTAL:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS — ladder is total. All ${rows.length} cells resolved; all ${RECONCILIATION_STATUSES.length} values reachable.`);
