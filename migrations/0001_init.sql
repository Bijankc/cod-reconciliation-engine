-- ---------------------------------------------------------------------------
-- COD Reconciliation Engine — initial schema (Phase 0)
--
-- D1 is the READ MODEL (AP) plus the order registry. The Durable Object is the
-- authoritative write model (CP); everything in `orders` below the registry
-- columns is a projection of DO state and may lag.
--
-- Schema decisions from the decision log, folded in while that was still legal:
--   * orders.discrepancy_reason          (Decision 3)
--   * six-value reconciliation_status    (Decision 3, incl. AWAITING_CONFIRMATION)
--   * orphan_events table                (Decision 5)
--   * CHECK constraints mirroring the TS const arrays in src/shared/constants.ts
--   * order_events.outcome = the ledger's three verdicts + delivery_count (Decision 9)
--
-- The CHECK constraints are deliberate redundancy: the enums live in TypeScript
-- as the single source of truth, and the database refuses to store anything
-- outside them. If these two ever disagree, the write fails loudly instead of
-- silently corrupting the read model.
-- ---------------------------------------------------------------------------

-- Order registry + projection of the DO ledger.
CREATE TABLE IF NOT EXISTS orders (
  order_id              TEXT PRIMARY KEY,
  merchant_id           TEXT NOT NULL,
  customer_name         TEXT NOT NULL,

  -- Money: whole NPR integers only (Decision 1). No minor units, ever.
  cod_amount            INTEGER NOT NULL CHECK (cod_amount > 0),
  amount_collected      INTEGER NOT NULL DEFAULT 0 CHECK (amount_collected >= 0),

  -- Lifecycle state, projected from the DO state machine.
  current_status        TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (current_status IN ('PENDING','DISPATCHED','DELIVERED','RETURNED')),

  -- Reconciliation verdict — six values, total ladder (Decision 3).
  reconciliation_status TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (reconciliation_status IN (
                            'PENDING',
                            'PARTIALLY_COLLECTED',
                            'AWAITING_CONFIRMATION',
                            'FULLY_COLLECTED',
                            'RETURNED_UNPAID',
                            'DISCREPANCY'
                          )),

  -- Which call the merchant should make. Non-null iff DISCREPANCY (Decision 3).
  discrepancy_reason    TEXT
                          CHECK (discrepancy_reason IS NULL OR discrepancy_reason IN (
                            'RETURNED_WITH_PAYMENT',
                            'DELIVERED_UNDERPAID',
                            'OVERPAID'
                          )),

  last_event_at         TEXT,

  -- Monotonic version from the DO. The consumer writes only when the incoming
  -- version is strictly greater, so a late projection write cannot rewind the
  -- read model.
  projection_version    INTEGER NOT NULL DEFAULT 0 CHECK (projection_version >= 0),

  created_at            TEXT NOT NULL,

  -- The invariant that keeps the flag and its explanation in lockstep:
  -- a DISCREPANCY always carries a reason, and nothing else ever does.
  CHECK ((reconciliation_status = 'DISCREPANCY') = (discrepancy_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_reconciliation ON orders (reconciliation_status);

-- Indexed event metadata for the order timeline. Raw bytes live in R2; this
-- table holds only what the dashboard needs to render and link.
CREATE TABLE IF NOT EXISTS order_events (
  event_id     TEXT PRIMARY KEY,            -- the idempotency key
  order_id     TEXT NOT NULL,
  type         TEXT NOT NULL
                 CHECK (type IN (
                   'delivery_attempted',
                   'payment_collected',
                   'partial_payment',
                   'delivery_confirmed',
                   'returned'
                 )),
  amount       INTEGER CHECK (amount IS NULL OR amount > 0),
  occurred_at  TEXT,                        -- courier's clock
  received_at  TEXT NOT NULL,               -- our clock
  -- The ledger's verdict, and only ever one of its three verdicts (Decision 9).
  -- A verdict can be revised exactly once, buffered -> applied, when the event
  -- drains out of the pending buffer.
  outcome      TEXT NOT NULL
                 CHECK (outcome IN ('applied','buffered','anomaly')),

  -- How many times the pipeline was handed this event_id. 1 is the normal case;
  -- 2+ means a genuine courier duplicate or a queue redelivery, which at this
  -- layer are indistinguishable and both mean the same thing: the ledger was
  -- asked twice and moved money once. Projected from the DO's count, never
  -- incremented locally, so re-running the write is idempotent.
  delivery_count INTEGER NOT NULL DEFAULT 1 CHECK (delivery_count >= 1),

  courier_id   TEXT,
  raw_r2_key   TEXT,                        -- pointer into the R2 audit log
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
);

CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events (order_id, received_at DESC);

-- ---------------------------------------------------------------------------
-- Orphan events (Decision 5).
--
-- An event naming an order_id that does not exist in `orders`. It is written to
-- R2 first (always), recorded here, and then ACKED — never thrown, never
-- dead-lettered, and never forwarded to a Durable Object, because addressing a
-- DO by an unknown name would spawn a phantom ledger holding real money.
--
-- Orphans are TERMINAL: nothing reprocesses them. They exist to be queried as an
-- unmatched-events view. This table exists precisely so `order_events` can keep
-- its foreign key strong — the FK is the thing that makes a phantom impossible,
-- so we route around it rather than weaken it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orphan_events (
  event_id     TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL,               -- the order_id that did not resolve; NO foreign key
  type         TEXT NOT NULL
                 CHECK (type IN (
                   'delivery_attempted',
                   'payment_collected',
                   'partial_payment',
                   'delivery_confirmed',
                   'returned'
                 )),
  amount       INTEGER CHECK (amount IS NULL OR amount > 0),
  occurred_at  TEXT,
  received_at  TEXT NOT NULL,
  courier_id   TEXT,
  raw_r2_key   TEXT NOT NULL,               -- always written: R2 first, then this row
  reason       TEXT NOT NULL DEFAULT 'UNKNOWN_ORDER'
                 CHECK (reason IN ('UNKNOWN_ORDER'))
);

CREATE INDEX IF NOT EXISTS idx_orphan_events_order ON orphan_events (order_id, received_at DESC);
