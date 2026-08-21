# COD Reconciliation Engine — Build Spec & Claude Code Kickoff Brief

> **How to use this file:** Paste it into Claude Code as the project brief, then build in the phase order at the bottom (Phase 0 → 6). Each phase is a checkpoint you can review before moving on. The README section at the end is the graded deliverable — keep it open as you build so the "why" is written while the decisions are fresh.

---

## 1. What we're building

An **async trust layer for cash-on-delivery (COD) orders** in Nepali e-commerce.

A merchant creates an order with a COD amount. A courier (simulated) reports lifecycle events to a webhook — `delivery_attempted`, `payment_collected`, `partial_payment`, `returned` — which arrive **late, out of order, and sometimes twice**. The system ingests them through a Queue, reconciles each order's money-truth on a **strongly-consistent per-order ledger**, and shows merchants a **live dashboard** of what's actually been collected vs. expected.

The real-world hook (open the README with this): *a COD order marked `delivered` on one system but `returned` on another, or a payment counted twice because the courier's webhook fired twice.* Reconciliation is the act of arriving at one true answer.

---

## 2. Stack (all Cloudflare free tier)

| Layer | Primitive | Role |
|---|---|---|
| Ingress / API | **Worker** | Webhook receiver + merchant API. Serverless (the Lambda-family model). |
| Ingestion | **Queue** | Buffers courier events; at-least-once delivery; retries + DLQ. |
| Ledger (write model) | **Durable Object per order** | Single-threaded, strongly consistent. The CP core. Prevents lost updates. |
| Read model | **D1** | Eventually-consistent projection for dashboard reads (AP). |
| Audit | **R2** | Immutable raw-event payloads (append-only audit log). |
| Frontend | **Pages** | Order form + reconciliation dashboard + event simulator. |

> Free-tier note for the README: verify current limits before submitting (Queues operations/day, D1 rows read/written, DO requests, R2 ops). All comfortably within a demo's needs, but name them — showing you know the constraints is part of the grade.

---

## 3. The architecture in one diagram

```
Merchant ──POST /api/orders──▶ Worker ──▶ D1 (order registry, status=pending)
                                     └──▶ (DO created lazily on first event)

Courier ──POST /webhook/courier──▶ Worker ──validate──▶ Queue  (202 fast ack)
                                                          │
                                                          ▼
                                        Queue Consumer (Worker)
                                          1. write raw payload → R2 (audit)
                                          2. call Order DO with event
                                                          │
                                                          ▼
                                     Durable Object (order_id)  ◀── CP ledger
                                       - dedup by event_id
                                       - state machine transition
                                       - update amount_collected
                                       - persist (transactional)
                                       - return new projected state
                                                          │
                                          3. write projection → D1 (read model)

Dashboard ──GET /api/orders──▶ Worker ──▶ D1  (eventually consistent reads, AP)
```

This is **CQRS-lite**: the Durable Object is the authoritative **write model** (CP), D1 is the **read model** (AP). Name that in the README — it's the frame that makes the three-zone consistency story coherent.

---

## 4. The three consistency zones (the A-grade section)

Do **not** describe the app as "an AP system." CAP is about what a *replicated datastore does during a partition*; your ledger is single-writer, so the honest framing is three zones, each with a deliberately chosen posture:

1. **Ingestion path — async, disorder-tolerant.** Events hit the Queue at-least-once, out of order, possibly duplicated. Handled with idempotency keys + a state machine. You're not relaxed about correctness — you tolerate *disorder in arrival* and converge deterministically. (Day 4.)
2. **Reconciliation ledger — CP.** Payment state is money-truth; concurrent writes must be serialized or you get a lost update. One Durable Object per order = single-threaded = the lost update is structurally impossible. This is the Day 3 banking-ledger case study, made literal.
3. **Dashboard reads — genuinely AP.** A merchant view that's two seconds stale is fine. Eventually-consistent reads from the D1 projection. This is the Day 3 like-counter tolerance, honestly applied.

**"Async AP ingestion → CP ledger → eventually-consistent reads."** One sentence that proves you can place all three postures deliberately in one system.

---

## 5. Data contracts

### 5.1 Courier event (what the webhook receives)

```jsonc
// POST /webhook/courier
// Header: Authorization: Bearer <COURIER_SHARED_SECRET>   // simple auth gesture
{
  "event_id":   "evt_9f8a...",   // UNIQUE per event — the idempotency key
  "order_id":   "ord_123",
  "type":       "payment_collected", // enum, see state machine
  "amount":     1500,               // required for payment_collected / partial_payment; minor units or NPR
  "occurred_at": "2026-08-21T09:14:00Z", // courier's timestamp of when it happened
  "courier_id": "sim-courier-1",
  "schema_version": 1               // additive-only evolution; see §9
}
```

Worker validates: required fields present, `type` in enum, `amount` present when required, types correct. Malformed → `400` (never enqueued). Valid → enqueue, return `202 Accepted`.

### 5.2 Queue message

The validated event JSON (as above). The consumer writes it to R2 and forwards it to the DO.

### 5.3 Order creation (merchant API)

```jsonc
// POST /api/orders
{ "customer_name": "Aakancha Thapa", "cod_amount": 1500, "merchant_id": "m1" }
// → 201 { "order_id": "ord_123" }
```

---

## 6. The order state machine (lives in the Durable Object)

States: `PENDING → DISPATCHED → { DELIVERED | RETURNED }`, with money tracked orthogonally.

```
                 delivery_attempted
   PENDING ───────────────────────▶ DISPATCHED
                                       │  │
                        payment_collected / partial_payment (accrues amount_collected)
                                       │  │
                        delivery_confirmed│  │ returned
                                       ▼  ▼
                                 DELIVERED  RETURNED
```

**Legal transitions** (reject/buffer anything else):

| Current | Event | Result |
|---|---|---|
| PENDING | `delivery_attempted` | → DISPATCHED |
| DISPATCHED | `payment_collected` | stay DISPATCHED, `amount_collected += amount` |
| DISPATCHED | `partial_payment` | stay DISPATCHED, `amount_collected += amount` |
| DISPATCHED | `delivery_confirmed` | → DELIVERED |
| DISPATCHED | `returned` | → RETURNED |
| DELIVERED / RETURNED | any | terminal — ignore or flag as anomaly |

**Reconciliation outcome** (computed, shown on dashboard):
- `FULLY_COLLECTED` — DELIVERED and `amount_collected >= cod_amount`
- `PARTIALLY_COLLECTED` — `0 < amount_collected < cod_amount`
- `RETURNED_UNPAID` — RETURNED and `amount_collected == 0`
- `DISCREPANCY` — 🚩 e.g. RETURNED but `amount_collected > 0`, or DELIVERED but underpaid
- `PENDING` — nothing applied yet

### Out-of-order handling (the sophisticated bit, and it's demoable)

The DO keeps a **pending buffer**. On each event:
1. **Dedup:** `event_id` already in `processed_ids`? → skip (idempotent). Done.
2. **Legal now?** → apply, record `event_id`, append to history, then **re-drain the buffer** (a buffered event may now be legal).
3. **Illegal but plausibly early** (e.g. `returned` before `delivery_attempted`)? → push to pending buffer.
4. **Illegal and stale** (`occurred_at` older than last applied, or terminal-state violation)? → record as anomaly, don't mutate money-truth.

Demo: fire `returned` first (buffered), then `delivery_attempted` (applies, drains buffer → `returned` now applies). Ledger converges correctly regardless of arrival order.

---

## 7. Storage layouts

### 7.1 Durable Object storage (authoritative write model, per order)

Use the **SQLite-backed DO** (the only backend on the free plan). Simplest: the storage KV API.

```
key: "state" → {
  status, cod_amount, amount_collected,
  reconciliation_status, last_occurred_at
}
key: "processed_ids" → Set<event_id>        // dedup
key: "history"       → [ applied events... ] // ordered
key: "pending"       → [ buffered events... ]// out-of-order holding pen
```

All mutations happen inside the single-threaded DO → transactional, no locks needed. (This is the whole point: serialization is free.)

### 7.2 D1 (read model + order registry)

```sql
CREATE TABLE orders (
  order_id             TEXT PRIMARY KEY,
  merchant_id          TEXT,
  customer_name        TEXT,
  cod_amount           INTEGER NOT NULL,
  current_status       TEXT NOT NULL DEFAULT 'PENDING',
  amount_collected     INTEGER NOT NULL DEFAULT 0,
  reconciliation_status TEXT NOT NULL DEFAULT 'PENDING',
  last_event_at        TEXT,
  projection_version   INTEGER NOT NULL DEFAULT 0,  -- monotonic; drop stale projection writes
  created_at           TEXT NOT NULL
);

CREATE TABLE order_events (      -- indexed metadata for the timeline (raw bytes live in R2)
  event_id     TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL,
  type         TEXT NOT NULL,
  amount       INTEGER,
  occurred_at  TEXT,
  received_at  TEXT NOT NULL,
  outcome      TEXT NOT NULL,    -- applied | duplicate | buffered | anomaly
  raw_r2_key   TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
);
```

**Projection ordering:** the DO returns a monotonically increasing version with each state; the consumer writes to D1 only if the incoming version > stored `projection_version`. Prevents an out-of-order projection write from making the read model go backwards.

### 7.3 R2 (audit log)

Key: `events/{order_id}/{event_id}.json` → raw received payload. Immutable, write-once. Gives you a reconciliation-report artifact and a "different data, different shape" (Day 1) talking point.

---

## 8. API surface

| Method | Path | Purpose | Reads/Writes |
|---|---|---|---|
| POST | `/api/orders` | Merchant creates an order | D1 write |
| GET | `/api/orders` | Dashboard list | D1 read (AP) |
| GET | `/api/orders/:id` | Order detail + event timeline | D1 read (AP) |
| GET | `/api/orders/:id?authoritative=true` | Read straight from the DO (CP truth) | DO read |
| GET | `/api/orders/:id/audit` | List raw event refs from R2 | R2 list |
| POST | `/webhook/courier` | Courier reports an event | validate → Queue |

> The `?authoritative=true` toggle is a teaching feature: the dashboard can show "projected (AP) vs authoritative (CP)" side by side, making the replication-lag / read-model concept visible. Great for the demo video.

---

## 9. Reliability primitives to implement (Day 4 checklist — make each explicit in the README)

- **Idempotency:** `event_id` dedup in the DO. The crown jewel — a `payment_collected` processed twice would double-count cash; this is the duplicate-charge case study reproduced in your own system.
- **At-least-once handling:** consumer + DO are idempotent. On transient failure (e.g. D1 write hiccup) **throw** so the Queue retries with backoff.
- **Dead-letter queue:** poison events (repeatedly failing) land in a DLQ instead of blocking the pipeline.
- **Timeouts / fast ack:** webhook does minimal validation and returns `202` immediately; heavy work is async.
- **Backpressure:** the Queue buffers spikes; consumer concurrency is a tuning knob — mention the tradeoff.
- **Ordering:** the state-machine + pending-buffer converges regardless of arrival order.
- **Schema evolution (EDI nod):** the event schema is versioned and additive-only. Safe = add optional field; unsafe = remove/rename. One paragraph tying this to EDIFACT/ANSI X12 structured document exchange between a platform and its logistics partner is enough — don't overclaim.

---

## 10. Frontend (Pages)

1. **Order form** — create an order, get an `order_id`.
2. **Dashboard** — table of orders: expected vs collected, status, reconciliation flag (🚩 discrepancies highlighted). Auto-refresh by polling → visibly demonstrates eventual consistency.
3. **Order detail** — event timeline (from D1), ledger, and the **projected-vs-authoritative** toggle.
4. **Simulator panel** — the demo centerpiece. Pick an order, then buttons:
   - "Happy path" (dispatched → paid → delivered)
   - **"Send payment_collected twice"** (duplicate → ledger stays correct)
   - **"Send returned before delivery_attempted"** (out-of-order → buffered → converges)
   - "Partial payment"
   - "Custom event" (type + amount + occurred_at)

The simulator POSTs to `/webhook/courier` — it's a real external event source you don't control the ordering of, not internal fake-firing.

---

## 11. Wrangler config sketch

```jsonc
// wrangler.jsonc
{
  "name": "cod-reconciliation-engine",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",

  "queues": {
    "producers": [{ "binding": "COURIER_QUEUE", "queue": "courier-events" }],
    "consumers": [{
      "queue": "courier-events",
      "max_batch_size": 10,
      "max_retries": 5,
      "dead_letter_queue": "courier-events-dlq"
    }]
  },

  "durable_objects": {
    "bindings": [{ "name": "ORDER_LEDGER", "class_name": "OrderLedger" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["OrderLedger"] }  // SQLite backend = free tier
  ],

  "d1_databases": [
    { "binding": "DB", "database_name": "cod-recon", "database_id": "<id>" }
  ],

  "r2_buckets": [
    { "binding": "AUDIT", "bucket_name": "cod-recon-audit" }
  ]
}
```

---

## 12. Build phases (proceed one at a time, checkpoint each)

- **Phase 0 — scaffold.** `npm create cloudflare` (Worker + TS). Add Wrangler bindings (Queue, DO, D1, R2). Create the D1 schema. Deploy the empty Worker so the pipeline exists.
- **Phase 1 — order API.** `POST/GET /api/orders` against D1. No events yet.
- **Phase 2 — webhook + queue.** `POST /webhook/courier` validates and enqueues; consumer just logs + writes raw to R2. Prove the async path end to end.
- **Phase 3 — the ledger DO.** `OrderLedger` class: dedup, state machine, money accrual, pending buffer. Consumer calls it. This is the heart — get it right and test it hard.
- **Phase 4 — projection to D1.** Consumer writes the DO's returned state to D1 with the version guard. Dashboard reads work.
- **Phase 5 — frontend on Pages.** Order form, dashboard (polling), order detail, projected-vs-authoritative toggle.
- **Phase 6 — simulator + polish.** The duplicate / out-of-order buttons, DLQ wiring, README.

**Testing priority:** before the frontend, write a script that fires (a) a duplicate `payment_collected` and (b) `returned` before `delivery_attempted`, and assert the ledger converges correctly. That test *is* your proof of the two hardest claims in the README.

---

## 13. README section outline (the graded deliverable)

1. **The problem** — COD reconciliation in Nepal; open with the concrete failure hook.
2. **What it does** — demo-first, with a GIF/screenshot of the simulator.
3. **Architecture** — the diagram from §3.
4. **The three consistency zones** — §4. *This is the section that earns the grade.*
5. **Why Queues** — real async (courier events genuinely arrive late/dup/out-of-order), at-least-once, the idempotency story.
6. **Why a Durable Object for the ledger** — CP, serialized writes, lost-update prevention; **and why not just D1** (the tradeoff you consciously rejected).
7. **Why D1 for reads, R2 for audit** — CQRS write/read split; different data, different shape.
8. **Reliability primitives** — the §9 checklist, each tied to the Day 4 case study.
9. **Compute choices** — serverless everywhere (Workers = Lambda-family), and Durable Objects to escape the "statelessness forced on you" limitation for the one stateful part (Day 2).
10. **What I deliberately didn't use** — Workflows (durable execution, considered, not needed), KV for the ledger (eventual consistency wrong for money-truth), synchronous processing, a real courier API.
11. **Schema evolution / EDI nod** — one paragraph.
12. **Run it locally + deploy + how to drive the simulator.**
13. **Honest limitations** — the courier is simulated (no Pathao/Aramex access); the reconciliation engine is the real part.

---

## 14. Course-concept coverage map (sanity check — every day should light up)

| Day | Concept | Where it shows up |
|---|---|---|
| 1 | Compute / Queue / DB / Object store; fire-and-forget; "different data, different shape" | Whole stack; R2 vs D1 vs DO state |
| 2 | Serverless vs server; stateless vs stateful; CPU vs IO-bound; concurrency | Workers; DO for state; IO-bound consumer; single-threaded serialization |
| 3 | CAP (C vs A); banking ledger (CP); like counter (AP); isolation / lost update; CQRS | The three zones; DO ledger; D1 read model |
| 4 | Sync vs async; idempotency keys; retries; at-least-once; DLQ; backpressure; schema evolution | Queue ingestion; dedup; DLQ; versioned event schema |
