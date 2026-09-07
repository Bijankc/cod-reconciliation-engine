import type {
  CourierEventType,
  DiscrepancyReason,
  OrderStatus,
  ReconciliationStatus,
} from "./constants.ts";

/** The validated courier event — the Queue message body (spec 5.1 / 5.2). */
export interface CourierEvent {
  event_id: string;
  order_id: string;
  type: CourierEventType;
  /** Whole NPR. Present for payment events; ignored (not rejected) otherwise. */
  amount?: number;
  occurred_at: string;
  courier_id?: string;
  schema_version: number;
}

/**
 * What actually travels on the Queue: the validated event plus the verbatim
 * request body, so the consumer can write the original bytes to the audit log
 * without
 * re-serialising and silently dropping unknown fields from a future schema
 * version (spec section 9, additive-only evolution).
 */
export interface QueuedCourierEvent extends CourierEvent {
  raw: string;
}

/** The DO's authoritative state, and the shape projected into D1. */
export interface LedgerState {
  order_id: string;
  status: OrderStatus;
  cod_amount: number;
  amount_collected: number;
  reconciliation_status: ReconciliationStatus;
  discrepancy_reason: DiscrepancyReason | null;
  last_occurred_at: string | null;
  /** Monotonic. The consumer drops any projection write that isn't newer. */
  version: number;
}
