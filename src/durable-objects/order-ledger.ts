/**
 * OrderLedger — the authoritative write model (Zone 2, CP).
 *
 * One instance per order_id, addressed by name. Single-threaded by construction:
 * every event for an order is serialised through this object, so the lost update
 * that a shared-database design defends against with locks or optimistic retries
 * is not defended against here — it is structurally impossible.
 *
 * Everything below assumes events arrive late, out of order, and more than once,
 * because they do. Three mechanisms make that survivable:
 *
 *   DEDUP       event_id is the idempotency key. A repeat is answered with the
 *               ORIGINAL verdict and the CURRENT version, and mutates nothing.
 *   BUFFER      an event that is illegal now but plausibly early is held, and
 *               retried every time the state advances, until it fits.
 *   LADDER      reconciliation is recomputed from scratch after every applied
 *               event, so the verdict is a function of state, never of history.
 *
 * Storage layout (spec 7.1), on the SQLite-backed KV API:
 *   "state"     LedgerCore — the money-truth
 *   "processed" event_id -> { outcome, version } — dedup + original verdict
 *   "history"   applied events, in the order they were applied
 *   "pending"   the out-of-order holding pen
 *   "version"   monotonic projection version
 */

import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env.d.ts";
import type { CourierEvent, LedgerState } from "../shared/types.ts";
import {
  isPaymentEvent,
  isTerminalStatus,
  type EventOutcome,
  type OrderStatus,
} from "../shared/constants.ts";
import { reconcile } from "../shared/reconciliation.ts";

/** The money-truth. Everything else in storage is bookkeeping around this. */
interface LedgerCore {
  order_id: string;
  status: OrderStatus;
  cod_amount: number;
  amount_collected: number;
  last_occurred_at: string | null;
}

interface ProcessedRecord {
  outcome: EventOutcome;
  version: number;
}

interface HistoryEntry {
  event_id: string;
  type: string;
  amount?: number;
  occurred_at: string;
  applied_at: string;
  version: number;
}

export interface LedgerResult {
  outcome: EventOutcome;
  state: LedgerState;
  /** How many buffered events became legal as a result of this one. */
  drained: number;
}

/** What a single event can do to the ledger. */
type Verdict = "apply" | "buffer" | "anomaly";

export class OrderLedger extends DurableObject<Env> {
  // -------------------------------------------------------------------------
  // Pure decision logic — no storage, no I/O.
  // -------------------------------------------------------------------------

  /**
   * The spec section 6 transition table, plus the two rules that make
   * out-of-order arrival survivable.
   */
  private classify(event: CourierEvent, core: LedgerCore): Verdict {
    // Terminal states absorb nothing. A DELIVERED or RETURNED order receiving a
    // further event is a real anomaly, not a late arrival: there is no future
    // state in which it becomes legal, so buffering it would leak an event that
    // can never drain.
    if (isTerminalStatus(core.status)) return "anomaly";

    if (isPaymentEvent(event.type)) {
      // Money accrues only once the order is out for delivery. A payment seen
      // while still PENDING is plausibly just early — the delivery_attempted
      // that precedes it is presumably still in flight.
      return core.status === "DISPATCHED" ? "apply" : "buffer";
    }

    // From here the event is a STATE TRANSITION, and only these are subject to
    // the staleness rule. A transition whose occurred_at predates the last one
    // applied describes a world the ledger has already moved past.
    //
    // Payments are deliberately exempt: they are ADDITIVE, and a valid payment
    // in the current state must accrue even if its occurred_at predates an
    // earlier payment. Dropping cash on timestamp order alone loses real money.
    if (
      core.last_occurred_at !== null &&
      Date.parse(event.occurred_at) < Date.parse(core.last_occurred_at)
    ) {
      return "anomaly";
    }

    switch (event.type) {
      case "delivery_attempted":
        // Only PENDING -> DISPATCHED is legal. A second attempt against an
        // already-dispatched order changes nothing and mutates no money.
        return core.status === "PENDING" ? "apply" : "anomaly";
      case "delivery_confirmed":
      case "returned":
        // Legal from DISPATCHED. Arriving while still PENDING means the
        // dispatch event is late — hold it and retry when that lands.
        return core.status === "DISPATCHED" ? "apply" : "buffer";
      default:
        return "anomaly";
    }
  }

  /** Applies one event to the core. Callers must have classified it "apply". */
  private mutate(event: CourierEvent, core: LedgerCore): LedgerCore {
    if (isPaymentEvent(event.type)) {
      // The single accrual path shared by payment_collected and partial_payment
      // (Decision 2), with NO clamping at cod_amount (Decision 4). The ledger
      // records what happened; the ladder decides what it means.
      return { ...core, amount_collected: core.amount_collected + (event.amount ?? 0) };
    }

    const status: OrderStatus =
      event.type === "delivery_attempted"
        ? "DISPATCHED"
        : event.type === "delivery_confirmed"
          ? "DELIVERED"
          : "RETURNED";

    // last_occurred_at tracks STATE TRANSITIONS only. Letting a payment advance
    // the staleness watermark would start dropping legitimate transitions.
    return { ...core, status, last_occurred_at: event.occurred_at };
  }

  private project(core: LedgerCore, version: number): LedgerState {
    const { reconciliation_status, discrepancy_reason } = reconcile(
      core.status,
      core.amount_collected,
      core.cod_amount,
    );
    return {
      order_id: core.order_id,
      status: core.status,
      cod_amount: core.cod_amount,
      amount_collected: core.amount_collected,
      reconciliation_status,
      discrepancy_reason,
      last_occurred_at: core.last_occurred_at,
      version,
    };
  }

  // -------------------------------------------------------------------------
  // RPC surface
  // -------------------------------------------------------------------------

  /**
   * Apply one courier event. The consumer supplies cod_amount, read from D1 in
   * the same query that confirmed the order exists (Decision 5), so the ledger
   * never reaches back into the read model to learn what it is owed.
   */
  async applyEvent(event: CourierEvent, codAmount: number): Promise<LedgerResult> {
    const stored = await this.ctx.storage.get<unknown>([
      "state",
      "processed",
      "history",
      "pending",
      "version",
    ]);

    let core =
      (stored.get("state") as LedgerCore | undefined) ??
      ({
        order_id: event.order_id,
        status: "PENDING",
        cod_amount: codAmount,
        amount_collected: 0,
        last_occurred_at: null,
      } satisfies LedgerCore);

    const processed =
      (stored.get("processed") as Record<string, ProcessedRecord> | undefined) ?? {};
    const history = (stored.get("history") as HistoryEntry[] | undefined) ?? [];
    let pending = (stored.get("pending") as CourierEvent[] | undefined) ?? [];
    let version = (stored.get("version") as number | undefined) ?? 0;

    // ---- 1. Dedup, before anything else. -----------------------------------
    // A repeat returns the verdict the event earned the FIRST time and the
    // CURRENT version, and does not increment. Returning the original verdict
    // matters: at-least-once means the consumer may be re-asking about an event
    // whose D1 row it never managed to write, and "duplicate" would be the
    // wrong thing to record in that row.
    const seen = processed[event.event_id];
    if (seen !== undefined) {
      return { outcome: seen.outcome, state: this.project(core, version), drained: 0 };
    }

    // ---- 2. Classify. ------------------------------------------------------
    const verdict = this.classify(event, core);
    const appliedAt = new Date().toISOString();
    let drained = 0;

    if (verdict === "buffer") {
      pending = [...pending, event];
      processed[event.event_id] = { outcome: "buffered", version };
      await this.ctx.storage.put({ processed, pending });
      return { outcome: "buffered", state: this.project(core, version), drained: 0 };
    }

    if (verdict === "anomaly") {
      // Recorded, but money-truth is untouched.
      processed[event.event_id] = { outcome: "anomaly", version };
      await this.ctx.storage.put({ processed });
      return { outcome: "anomaly", state: this.project(core, version), drained: 0 };
    }

    // ---- 3. Apply. ---------------------------------------------------------
    core = this.mutate(event, core);
    version += 1;
    processed[event.event_id] = { outcome: "applied", version };
    history.push({
      event_id: event.event_id,
      type: event.type,
      ...(event.amount !== undefined ? { amount: event.amount } : {}),
      occurred_at: event.occurred_at,
      applied_at: appliedAt,
      version,
    });

    // ---- 4. Re-drain the buffer until a full pass applies nothing. ---------
    // One pass is not enough: applying a buffered event can unblock another.
    // A buffered `returned` and a buffered payment both wait on the same
    // delivery_attempted, and draining the payment first leaves the `returned`
    // legal only on the next pass. Looping until no progress is the only
    // version that converges regardless of how deep the pile-up got.
    let progress = true;
    while (progress) {
      progress = false;
      const stillPending: CourierEvent[] = [];

      for (const buffered of pending) {
        if (this.classify(buffered, core) === "apply") {
          core = this.mutate(buffered, core);
          version += 1;
          drained += 1;
          processed[buffered.event_id] = { outcome: "applied", version };
          history.push({
            event_id: buffered.event_id,
            type: buffered.type,
            ...(buffered.amount !== undefined ? { amount: buffered.amount } : {}),
            occurred_at: buffered.occurred_at,
            applied_at: appliedAt,
            version,
          });
          progress = true;
        } else {
          stillPending.push(buffered);
        }
      }

      pending = stillPending;
    }

    // One put() of every key. Each storage method is implicitly transactional,
    // so the ledger can never be observed with its money updated but its dedup
    // set not.
    await this.ctx.storage.put({ state: core, processed, history, pending, version });

    return { outcome: "applied", state: this.project(core, version), drained };
  }

  /** The authoritative (CP) read, for the dashboard's projected-vs-truth toggle. */
  async getState(): Promise<LedgerState | null> {
    const core = await this.ctx.storage.get<LedgerCore>("state");
    if (core === undefined) return null;
    const version = (await this.ctx.storage.get<number>("version")) ?? 0;
    return this.project(core, version);
  }

  /** Ledger internals, for the order-detail view and the convergence test. */
  async inspect(): Promise<{
    state: LedgerState | null;
    history: HistoryEntry[];
    pending: CourierEvent[];
    processed_count: number;
  }> {
    const stored = await this.ctx.storage.get<unknown>([
      "state",
      "processed",
      "history",
      "pending",
      "version",
    ]);
    const core = stored.get("state") as LedgerCore | undefined;
    const version = (stored.get("version") as number | undefined) ?? 0;
    const processed =
      (stored.get("processed") as Record<string, ProcessedRecord> | undefined) ?? {};
    return {
      state: core === undefined ? null : this.project(core, version),
      history: (stored.get("history") as HistoryEntry[] | undefined) ?? [],
      pending: (stored.get("pending") as CourierEvent[] | undefined) ?? [],
      processed_count: Object.keys(processed).length,
    };
  }
}
