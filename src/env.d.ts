/// <reference types="@cloudflare/workers-types" />

import type { QueuedCourierEvent } from "./shared/types.ts";
import type { OrderLedger } from "./durable-objects/order-ledger.ts";

export interface Env {
  /** Ingestion buffer. The webhook is a producer; the consumer drains it. */
  COURIER_QUEUE: Queue<QueuedCourierEvent>;
  /** One Durable Object per order — the authoritative, strongly-consistent ledger. */
  ORDER_LEDGER: DurableObjectNamespace<OrderLedger>;
  /** Read model, order registry, and the audit log of raw courier payloads. */
  DB: D1Database;
  /** Shared secret the simulated courier presents on the webhook. */
  COURIER_SHARED_SECRET?: string;
  /** Comma-separated origins allowed to call this API from a browser. */
  ALLOWED_ORIGINS?: string;
}
