/**
 * Merchant order API — Zone 3 (AP) reads, plus the one door into Zone 2 (CP).
 *
 * Almost everything here reads D1 only. The order registry is written at
 * creation; every column below the registry columns is a projection of Durable
 * Object state that may lag by a second or two, and the responses say so out
 * loud in a `source` / `consistency` pair rather than leaving the caller to
 * guess which zone answered.
 *
 * `?authoritative=true` on the detail route is the exception and the teaching
 * feature: it reads the ledger DIRECTLY, alongside the projection, and returns a
 * `divergence` block comparing them. Replication lag stops being a paragraph in
 * a README and becomes a number on screen — refresh during a burst of events and
 * watch `versions_behind` rise and fall back to zero.
 */

import type { Env } from "../env.d.ts";
import type { LedgerState } from "../shared/types.ts";
import {
  isValidAmount,
  CURRENCY,
  type CourierEventType,
  type DiscrepancyReason,
  type EventOutcome,
  type OrderStatus,
  type OrphanReason,
  type ReconciliationStatus,
} from "../shared/constants.ts";
import { json, notFound, validationFailed, badRequest, type FieldError } from "../shared/http.ts";

/** A row of the `orders` table, exactly as D1 returns it. */
interface OrderRow {
  order_id: string;
  merchant_id: string;
  customer_name: string;
  cod_amount: number;
  amount_collected: number;
  current_status: OrderStatus;
  reconciliation_status: ReconciliationStatus;
  discrepancy_reason: DiscrepancyReason | null;
  last_event_at: string | null;
  projection_version: number;
  created_at: string;
}

/** A row of `order_events` — the timeline, exactly as D1 returns it. */
interface EventRow {
  event_id: string;
  order_id: string;
  type: CourierEventType;
  amount: number | null;
  occurred_at: string | null;
  received_at: string;
  outcome: EventOutcome;
  delivery_count: number;
  courier_id: string | null;
  raw_r2_key: string | null;
}

/** A row of `orphan_events` — an event that named this order before it existed. */
interface OrphanRow {
  event_id: string;
  order_id: string;
  type: CourierEventType;
  amount: number | null;
  occurred_at: string | null;
  received_at: string;
  courier_id: string | null;
  raw_r2_key: string;
  reason: OrphanReason;
}

const MAX_CUSTOMER_NAME = 120;
const MAX_MERCHANT_ID = 64;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function newOrderId(): string {
  return `ord_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** Trimmed non-empty string, or null if the value isn't usable. */
function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

/**
 * POST /api/orders
 * { customer_name, cod_amount, merchant_id } -> 201 { order_id }
 */
export async function createOrder(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("Request body must be a JSON object.");
  }

  const input = body as Record<string, unknown>;
  const errors: FieldError[] = [];

  const customerName = cleanString(input.customer_name, MAX_CUSTOMER_NAME);
  if (customerName === null) {
    errors.push({
      field: "customer_name",
      message: `Required. Non-empty string, at most ${MAX_CUSTOMER_NAME} characters.`,
    });
  }

  const merchantId = cleanString(input.merchant_id, MAX_MERCHANT_ID);
  if (merchantId === null) {
    errors.push({
      field: "merchant_id",
      message: `Required. Non-empty string, at most ${MAX_MERCHANT_ID} characters.`,
    });
  }

  // The one amount predicate in the codebase (Decision 1): whole NPR, positive.
  if (!isValidAmount(input.cod_amount)) {
    errors.push({
      field: "cod_amount",
      message: `Required. Positive whole number of ${CURRENCY.code} (${CURRENCY.label}) — no decimals, no strings.`,
    });
  }

  if (errors.length > 0) return validationFailed(errors);

  const orderId = newOrderId();
  const createdAt = new Date().toISOString();

  // Explicit defaults rather than relying on the column defaults: the row that
  // gets written is the row you can read here.
  await env.DB.prepare(
    `INSERT INTO orders (
       order_id, merchant_id, customer_name, cod_amount, amount_collected,
       current_status, reconciliation_status, discrepancy_reason,
       last_event_at, projection_version, created_at
     ) VALUES (?, ?, ?, ?, 0, 'PENDING', 'PENDING', NULL, NULL, 0, ?)`,
  )
    .bind(orderId, merchantId, customerName, input.cod_amount as number, createdAt)
    .run();

  return json({ order_id: orderId }, 201, { location: `/api/orders/${orderId}` });
}

/**
 * GET /api/orders[?merchant_id=&limit=]
 * Dashboard list. Eventually-consistent read of the projection (Zone 3, AP).
 */
export async function listOrders(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const merchantId = cleanString(params.get("merchant_id"), MAX_MERCHANT_ID);

  const rawLimit = params.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return validationFailed([
        { field: "limit", message: `Must be a whole number between 1 and ${MAX_LIMIT}.` },
      ]);
    }
    limit = parsed;
  }

  const statement = merchantId
    ? env.DB.prepare(
        `SELECT * FROM orders WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?`,
      ).bind(merchantId, limit)
    : env.DB.prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT ?`).bind(limit);

  const { results } = await statement.all<OrderRow>();

  return json({
    orders: results,
    count: results.length,
    // Named in the payload so the dashboard can say out loud which zone it read.
    source: "d1_projection",
    consistency: "eventual",
  });
}

/**
 * How far the read model is trailing the ledger, field by field.
 *
 * `versions_behind` is the honest measure — the projection is not "wrong" when
 * it lags, it is a specific number of applied events behind, and that number
 * goes to zero on its own. A non-empty `diverged_fields` with
 * `versions_behind: 0` would be the genuinely alarming case: same version,
 * different answer, meaning a projection write went astray rather than late.
 */
function compareToLedger(order: OrderRow, state: LedgerState | null) {
  if (state === null) return null;

  const diverged: string[] = [];
  if (order.current_status !== state.status) diverged.push("current_status");
  if (order.amount_collected !== state.amount_collected) diverged.push("amount_collected");
  if (order.reconciliation_status !== state.reconciliation_status) {
    diverged.push("reconciliation_status");
  }
  if (order.discrepancy_reason !== state.discrepancy_reason) diverged.push("discrepancy_reason");

  return {
    projected_version: order.projection_version,
    authoritative_version: state.version,
    versions_behind: state.version - order.projection_version,
    diverged_fields: diverged,
    converged: diverged.length === 0 && order.projection_version === state.version,
  };
}

/**
 * GET /api/orders/:id[?authoritative=true]
 *
 * Order detail: the projected row, the event timeline, and any orphaned events
 * that named this order_id before it existed. With `authoritative=true`, the
 * ledger's own state is read alongside and the two are compared.
 */
export async function getOrder(
  orderId: string,
  env: Env,
  options: { authoritative: boolean } = { authoritative: false },
): Promise<Response> {
  const order = await env.DB.prepare(`SELECT * FROM orders WHERE order_id = ?`)
    .bind(orderId)
    .first<OrderRow>();

  // The existence check is load-bearing, not just politeness: naming a Durable
  // Object is what creates it (Decision 5), so the authoritative read below must
  // never be reachable for an order_id that D1 has never heard of.
  if (order === null) return notFound("order", orderId);

  const timelineQuery = env.DB.prepare(
    // Newest first, matching idx_order_events_order. received_at is our clock and
    // a whole batch can share a millisecond, so event_id breaks the tie and keeps
    // the ordering stable across repeated reads.
    `SELECT * FROM order_events WHERE order_id = ? ORDER BY received_at DESC, event_id DESC`,
  ).bind(orderId);

  const orphanQuery = env.DB.prepare(
    // Usually empty. When it is not, it explains an otherwise baffling order:
    // events that arrived before the merchant created it were acked and parked
    // here, and no amount of staring at the ledger would reveal them.
    `SELECT * FROM orphan_events WHERE order_id = ? ORDER BY received_at DESC, event_id DESC`,
  ).bind(orderId);

  const ledgerRead = options.authoritative
    ? env.ORDER_LEDGER.get(env.ORDER_LEDGER.idFromName(orderId)).inspect()
    : null;

  const [timeline, orphans, ledger] = await Promise.all([
    timelineQuery.all<EventRow>(),
    orphanQuery.all<OrphanRow>(),
    ledgerRead,
  ]);

  return json({
    order,
    timeline: timeline.results,
    orphan_events: orphans.results,
    source: "d1_projection",
    consistency: "eventual",

    // Present only when asked for. `state: null` means the ledger has never been
    // written — the order exists but no courier event has reached it yet, which
    // is a different thing from the ledger being empty of money.
    authoritative: ledger
      ? {
          source: "durable_object",
          consistency: "strong",
          state: ledger.state,
          history: ledger.history,
          pending: ledger.pending,
          processed_count: ledger.processed_count,
          duplicates: ledger.duplicates,
        }
      : null,
    divergence: ledger ? compareToLedger(order, ledger.state) : null,
  });
}
