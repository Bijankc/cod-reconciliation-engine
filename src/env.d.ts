/// <reference types="@cloudflare/workers-types" />

import type { QueuedCourierEvent } from "./shared/types.ts";
import type { OrderLedger } from "./durable-objects/order-ledger.ts";

export interface Env {
  /** Ingestion buffer. The webhook is a producer; the consumer drains it. */
  COURIER_QUEUE: Queue<QueuedCourierEvent>;
  /** One Durable Object per order — the authoritative, strongly-consistent ledger. */
  ORDER_LEDGER: DurableObjectNamespace<OrderLedger>;
  /** Read model + order registry. */
  DB: D1Database;
  /** Immutable audit log of raw courier payloads. */
  AUDIT: R2Bucket;
  /** Shared secret the simulated courier presents on the webhook. */
  COURIER_SHARED_SECRET?: string;
}
