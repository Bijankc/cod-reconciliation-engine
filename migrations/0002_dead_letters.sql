-- ---------------------------------------------------------------------------
-- 0002 — the dead-letter landing table (Phase 6).
--
-- This migration exists because 0001 is frozen, and it is the change 0001's
-- freeze banner named in advance as the one foreseeable schema addition. It is
-- a NEW table rather than an edit, exactly as predicted, and writing it cost
-- what editing 0001 would have cost. That was the whole argument for freezing
-- early: the discipline is free until the moment it is not.
--
-- WHAT LANDS HERE. A message the consumer failed on for every one of its
-- `max_retries` attempts. Cloudflare Queues then hands it to `courier-events-dlq`,
-- whose consumer writes a row here so a poison event is a QUERYABLE FACT rather
-- than a log line that scrolls away.
--
-- WHY IT IS SEPARATE FROM order_events. A dead letter is not a verdict. The
-- ledger never saw it, so it has no outcome, no version, and no effect on money.
-- Putting it in order_events would mean either weakening that table's outcome
-- CHECK to hold a non-verdict, or its foreign key to hold an order that may not
-- exist. The same reasoning that gave orphan_events its own table applies here:
-- route around a strong constraint rather than weaken it (Decision 5).
--
-- NO FOREIGN KEY, deliberately. A poison event may name an order that never
-- existed; that is one of the ways a message becomes poison.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dead_letters (
  event_id     TEXT PRIMARY KEY,
  order_id     TEXT,                      -- may name an order that does not exist
  type         TEXT,                      -- NOT constrained: a dead letter is not a verdict
  amount       INTEGER,
  occurred_at  TEXT,
  courier_id   TEXT,

  -- Our clock when the DLQ consumer recorded it, not the courier's.
  dead_lettered_at TEXT NOT NULL,

  -- Attempts as reported on the DLQ delivery. Queues resets the counter when a
  -- message moves to the dead-letter queue, so this is the DLQ consumer's own
  -- attempt count and NOT the number of times the main consumer failed. Recorded
  -- for what it is; see the README before reading anything else into it.
  dlq_attempts INTEGER,

  -- The verbatim payload. R2 already holds it under the audit key, but a dead
  -- letter is precisely the case where you want the bytes to hand without a
  -- second lookup into another service.
  raw          TEXT,

  reason       TEXT NOT NULL DEFAULT 'CONSUMER_FAILED'
);

CREATE INDEX IF NOT EXISTS idx_dead_letters_time ON dead_letters (dead_lettered_at DESC);
CREATE INDEX IF NOT EXISTS idx_dead_letters_order ON dead_letters (order_id);
