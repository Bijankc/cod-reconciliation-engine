/**
 * OrderLedger — the authoritative, strongly-consistent write model (Zone 2, CP).
 *
 * One instance per order_id. Single-threaded by construction, so the lost-update
 * problem is structurally impossible: no locks, no transactions to reason about.
 *
 * PHASE 0 SCAFFOLD. The class exists so the binding and the `v1` SQLite
 * migration are real at deploy time. Dedup, the state machine, money accrual and
 * the pending buffer land in Phase 3 — the reconciliation ladder it will call is
 * already written and proven total in src/shared/reconciliation.ts.
 */

import type { Env } from "../env.d.ts";

export class OrderLedger implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(_request: Request): Promise<Response> {
    return Response.json(
      { error: "not_implemented", phase: "OrderLedger lands in Phase 3" },
      { status: 501 },
    );
  }
}
