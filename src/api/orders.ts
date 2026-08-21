/**
 * Merchant order API — Phase 1.
 *
 * Reads and writes D1 only. This is the AP zone: the order registry is written
 * here at creation, and everything below the registry columns is later a
 * projection of Durable Object state that may lag by a second or two.
 */

import type { Env } from "../env.d.ts";
import {
  isValidAmount,
  CURRENCY,
  type DiscrepancyReason,
  type OrderStatus,
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
 * GET /api/orders/:id
 * Order detail. The timeline is empty until Phase 2 starts recording events.
 */
export async function getOrder(orderId: string, env: Env): Promise<Response> {
  const order = await env.DB.prepare(`SELECT * FROM orders WHERE order_id = ?`)
    .bind(orderId)
    .first<OrderRow>();

  if (order === null) return notFound("order", orderId);

  return json({
    order,
    timeline: [],
    source: "d1_projection",
    consistency: "eventual",
  });
}
