/**
 * Single source of truth for every enum and unit in the system.
 *
 * Rule: nothing in this file may be re-declared anywhere else. The validator,
 * the Durable Object state machine, the D1 CHECK constraints, the simulator and
 * the frontend all import from here so they cannot drift apart.
 */

// ---------------------------------------------------------------------------
// Money — Decision 1: whole NPR integers, everywhere, no exceptions.
// ---------------------------------------------------------------------------

/** The one currency/unit constant. Imported by validator, DO and frontend. */
export const CURRENCY = {
  code: "NPR",
  symbol: "Rs.",
  /** 0 = no subunit is ever stored or transmitted. Amounts are whole rupees. */
  minorUnits: 0,
  label: "whole NPR integers",
} as const;

/**
 * The only amount predicate in the codebase. A valid money amount is a positive
 * whole number of rupees. Rejects: floats, strings, NaN, Infinity, 0, negatives.
 */
export function isValidAmount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

/** Display helper — the frontend imports this so formatting never forks. */
export function formatAmount(amount: number): string {
  return `${CURRENCY.symbol} ${amount.toLocaleString("en-IN")}`;
}

// ---------------------------------------------------------------------------
// Courier events — Decision 2: five types, one array, derived union.
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  "delivery_attempted",
  "payment_collected",
  "partial_payment",
  "delivery_confirmed",
  "returned",
] as const;

export type CourierEventType = (typeof EVENT_TYPES)[number];

/**
 * The two types that move money. They share ONE accrual code path in the DO —
 * `partial_payment` is not a different algorithm, only a different label.
 */
export const PAYMENT_EVENT_TYPES = ["payment_collected", "partial_payment"] as const;

export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

export function isPaymentEvent(type: CourierEventType): type is PaymentEventType {
  return (PAYMENT_EVENT_TYPES as readonly string[]).includes(type);
}

export function isCourierEventType(value: unknown): value is CourierEventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

/** Current event schema version. Additive-only evolution (see README §9). */
export const CURRENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Order lifecycle status (the state machine's states)
// ---------------------------------------------------------------------------

export const ORDER_STATUSES = ["PENDING", "DISPATCHED", "DELIVERED", "RETURNED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Terminal states absorb no further transitions. */
export const TERMINAL_ORDER_STATUSES = ["DELIVERED", "RETURNED"] as const;

export function isTerminalStatus(status: OrderStatus): boolean {
  return (TERMINAL_ORDER_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Reconciliation — Decision 3: six values, total ladder.
// ---------------------------------------------------------------------------

export const RECONCILIATION_STATUSES = [
  "PENDING",
  "PARTIALLY_COLLECTED",
  "AWAITING_CONFIRMATION",
  "FULLY_COLLECTED",
  "RETURNED_UNPAID",
  "DISCREPANCY",
] as const;

export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

/** Only DISCREPANCY is a merchant-facing red flag. AWAITING_CONFIRMATION is benign. */
export const FLAGGED_RECONCILIATION_STATUSES = ["DISCREPANCY"] as const;

// ---------------------------------------------------------------------------
// Discrepancy reasons — populated only when status is DISCREPANCY.
// ---------------------------------------------------------------------------

export const DISCREPANCY_REASONS = [
  "RETURNED_WITH_PAYMENT",
  "DELIVERED_UNDERPAID",
  "OVERPAID",
] as const;

export type DiscrepancyReason = (typeof DISCREPANCY_REASONS)[number];

/** Human-readable text for the dashboard — tells the merchant which call to make. */
export const DISCREPANCY_REASON_TEXT: Record<DiscrepancyReason, string> = {
  RETURNED_WITH_PAYMENT: "Order was returned but money was collected — recover cash from courier.",
  DELIVERED_UNDERPAID: "Order was delivered but the full COD amount was never collected.",
  OVERPAID: "Collected more than the COD amount — refund the customer.",
};

// ---------------------------------------------------------------------------
// Per-event processing outcome (recorded in D1 order_events)
//
// Decision 9: these are EXACTLY the ledger's three verdicts, and nothing else.
// An outcome answers one question — what did the ledger DO with this event —
// so every value here must be something the Durable Object can return.
//
// Two values were removed in Phase 4 once the projection made them observable
// as dead: 'received' (a Phase 2 placeholder, unreachable the moment the
// consumer started recording real verdicts) and 'duplicate' (never a verdict at
// all — a redelivered event keeps the verdict it earned the first time, and how
// many times it arrived is counted separately in `delivery_count`).
// ---------------------------------------------------------------------------

export const EVENT_OUTCOMES = ["applied", "buffered", "anomaly"] as const;
export type EventOutcome = (typeof EVENT_OUTCOMES)[number];

/** Why an event was orphaned. Decision 5: today there is exactly one reason. */
export const ORPHAN_REASONS = ["UNKNOWN_ORDER"] as const;
export type OrphanReason = (typeof ORPHAN_REASONS)[number];
