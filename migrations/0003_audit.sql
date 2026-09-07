-- ---------------------------------------------------------------------------
-- 0003 — the audit log, as a D1 table (was R2).
--
-- WHAT LANDS HERE. The verbatim bytes of every courier payload the consumer
-- receives, written FIRST, before the order-existence check and before the
-- poison path. That ordering is the whole point: everything received leaves
-- evidence, including payloads for an order that does not exist yet and
-- messages designed to fail.
--
-- WHY D1 AND NOT R2. An object store is the right home for write-once opaque
-- blobs, and at real volume that is where this belongs. At demo volume the
-- row-write cost of storing a payload is negligible, and keeping ONE storage
-- primitive was simpler than standing up a second. See the README.
--
-- WHY IT IS ITS OWN TABLE. `order_events` holds the ledger's VERDICT on an
-- event; this holds the bytes that verdict was formed from. The audit log is
-- also strictly wider — it has rows `order_events` can never have, because it
-- is written before we know whether the order exists. Same reasoning that gave
-- orphan_events and dead_letters their own tables: a record that is not a
-- verdict does not belong in the verdict table.
--
-- NO FOREIGN KEY, deliberately. A payload may name an order that does not
-- exist; capturing exactly that case is one of the reasons the log is written
-- before the check.
--
-- IMMUTABLE BY CONVENTION. The consumer only ever inserts, with
-- ON CONFLICT(event_id) DO NOTHING, so an at-least-once redelivery rewrites
-- nothing and the first bytes we saw are the bytes that stay.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit (
  event_id     TEXT PRIMARY KEY,          -- the idempotency key, so redelivery is a no-op
  order_id     TEXT NOT NULL,             -- may name an order that does not exist
  payload      TEXT NOT NULL,             -- the verbatim request bytes, as received
  received_at  TEXT NOT NULL              -- our clock on arrival, not the courier's
);

-- The only query this table serves: every payload for one order, for the audit
-- view on the order detail page.
CREATE INDEX IF NOT EXISTS idx_audit_order ON audit (order_id);
