/**
 * Courier event validation (spec 5.1) — the webhook's only gate.
 *
 * FORWARD-COMPATIBLE BY DESIGN (spec section 9). The event schema evolves
 * additively: a safe change adds an optional field, an unsafe one removes or
 * renames. So this validator checks that the fields it *requires* are present and
 * well-formed, and is deliberately silent about everything else. An event
 * carrying fields from a future schema version passes untouched and is stored in
 * the audit log verbatim — a validator that rejected unknown fields would turn
 * every
 * additive change into a breaking one.
 *
 * Reuses isValidAmount() and the enum from ./constants.ts rather than restating
 * the rules, so the webhook and the order API cannot disagree.
 */

import {
  isCourierEventType,
  isPaymentEvent,
  isValidAmount,
  CURRENCY,
  type CourierEventType,
} from "./constants.ts";
import type { FieldError } from "./http.ts";
import type { CourierEvent } from "./types.ts";

const MAX_ID_LENGTH = 128;

export type ValidationResult =
  | { ok: true; event: CourierEvent }
  | { ok: false; errors: FieldError[] };

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ID_LENGTH) return null;
  return trimmed;
}

/** ISO-8601 instant the courier reports. Must parse, or ordering is meaningless. */
function cleanTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return value;
}

export function validateCourierEvent(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "_body", message: "Must be a JSON object." }] };
  }

  const input = body as Record<string, unknown>;
  const errors: FieldError[] = [];

  const eventId = cleanId(input.event_id);
  if (eventId === null) {
    errors.push({
      field: "event_id",
      message: "Required. Non-empty string — this is the idempotency key.",
    });
  }

  const orderId = cleanId(input.order_id);
  if (orderId === null) {
    errors.push({ field: "order_id", message: "Required. Non-empty string." });
  }

  let type: CourierEventType | null = null;
  if (!isCourierEventType(input.type)) {
    errors.push({
      field: "type",
      message:
        "Required. One of: delivery_attempted, payment_collected, partial_payment, delivery_confirmed, returned.",
    });
  } else {
    type = input.type;
  }

  const occurredAt = cleanTimestamp(input.occurred_at);
  if (occurredAt === null) {
    errors.push({
      field: "occurred_at",
      message: "Required. An ISO-8601 timestamp, e.g. 2026-08-21T09:14:00Z.",
    });
  }

  // Money is required and strict for the two payment types, and IGNORED — not
  // rejected — for the other three (Decision 1). A courier attaching a stray
  // amount to a lifecycle event should not fail that event's delivery.
  if (type !== null && isPaymentEvent(type) && !isValidAmount(input.amount)) {
    errors.push({
      field: "amount",
      message: `Required for ${type}. Positive whole number of ${CURRENCY.code} (${CURRENCY.label}) — no decimals, no strings.`,
    });
  }

  // Additive-only evolution: any integer version >= 1 is accepted, including
  // versions newer than we know about. Their extra fields ride along untouched.
  if (!Number.isInteger(input.schema_version) || (input.schema_version as number) < 1) {
    errors.push({ field: "schema_version", message: "Required. Integer >= 1." });
  }

  let courierId: string | undefined;
  if (input.courier_id !== undefined) {
    const cleaned = cleanId(input.courier_id);
    if (cleaned === null) {
      errors.push({ field: "courier_id", message: "Optional, but must be a non-empty string." });
    } else {
      courierId = cleaned;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Normalised, and carrying only the fields the pipeline acts on. The verbatim
  // payload — unknown future fields included — is what gets stored in the audit
  // log.
  const event: CourierEvent = {
    event_id: eventId!,
    order_id: orderId!,
    type: type!,
    occurred_at: occurredAt!,
    schema_version: input.schema_version as number,
    ...(courierId !== undefined ? { courier_id: courierId } : {}),
    ...(type !== null && isPaymentEvent(type) ? { amount: input.amount as number } : {}),
  };

  return { ok: true, event };
}
