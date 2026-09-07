# COD Reconciliation Engine

## What this is and why

An async trust layer for cash-on-delivery orders in Nepali e-commerce: it ingests late,
duplicated, out-of-order courier events and converges every order onto a single money-truth.

Workers + Queue + Durable Object + D1 + Pages, all on the Cloudflare free plan.

- **Durable Object per order** — the ledger is single-threaded, so two concurrent payments
  can't cause a lost update; D1 alone can't serialise the decide-then-accrue step.
- **A Queue in front of the ledger** — the webhook only authenticates, validates and enqueues,
  so it returns `202` before any storage work and our latency never becomes the courier's
  timeout, which is what spawns duplicate deliveries.
- **`event_id` idempotency** — at-least-once delivery makes duplicates certain rather than
  hypothetical.
- **D1 for reads and for audit** — two separate tables: the relational read model the
  dashboard queries, and the insert-only log of raw payloads as they arrived.
- **Eventually consistent where it can be** — the dashboard — and strongly consistent only
  where the money lives, in the ledger.

Everything below elaborates on those five.

---

A COD order shows `delivered` on one system and `returned` on another. A payment gets counted
twice because the courier's webhook fired twice. Reconciliation is the act of arriving at one
true answer.

Everything is verified against local emulation only. I have never created a Cloudflare resource
for it, and [Deferred to deploy](#deferred-to-deploy) says exactly what that leaves unsettled.

Four scripts stand behind the claims below:

| Script | What it checks |
|---|---|
| `npm run verify:convergence` | **72 assertions.** A duplicate payment moves money once, `returned` before `delivery_attempted` converges, a held event that becomes impossible is evicted, and the projection matches the ledger. |
| `npm run verify:ladder` | **28 cells.** Every status × money combination resolves, and all six verdicts are reachable. |
| `npm run verify:cors` | **33 assertions** covering the CORS logic, including the negative cases. It's a script sending browser-shaped headers; no real browser is involved. |
| `npm run verify:dlq` | Fires a real poison event and watches for the dead-letter hand-off. |

---

## What it does

A merchant books a COD order for Rs. 1,500. A courier goes out and reports what happened over
the next few hours: dispatched, collected, delivered, returned. Those reports arrive late, out
of order, and sometimes twice, because that is what third-party webhooks do. The system ingests
them, converges each order onto one money-truth, and shows the merchant which orders have a
problem.

The two demos worth watching are the two that break naive systems.

### Send the same `payment_collected` twice

A courier whose webhook call timed out retries it. Both deliveries are real HTTP requests
carrying the same `event_id`. The ledger applies the first, recognises the second, and moves
money once. The timeline row reads `applied · ×2` next to an unchanged total. A system that
trusted its inbox would have booked Rs. 3,000 against a Rs. 1,500 order and flagged the
merchant's own customer for overpayment.

### Send `returned` before `delivery_attempted`

The order has not been dispatched, so `returned` is illegal in that state. It's also perfectly
plausible, since the dispatch event is presumably still in flight. The ledger holds it, the
timeline shows `buffered`, and no money moves. When `delivery_attempted` lands, the buffer
drains and both events apply in causal order, converging on the same answer the ledger would
have reached if the courier had called in sequence.

Both are drivable from the console's simulator panel, which makes real authenticated POSTs to
the courier webhook. A third button sends a deliberately poisonous event so you can watch a bad
message get set aside instead of blocking the pipeline.

---

## Architecture

```text
Merchant ──POST /api/orders──▶ Worker ──▶ D1 (order registry, status=PENDING)
                                     └──▶ (the ledger DO is created lazily, by the first event)

Courier ──POST /webhook/courier──▶ Worker ──auth, validate──▶ Queue   (202, fast ack)
                                                               │
                                                               ▼
                                             Queue consumer (Worker)
                                               1. raw payload → D1 audit table   (always first)
                                               2. does the order exist?   (D1 — orphan path if not)
                                               3. call the order's ledger
                                                               │
                                                               ▼
                                          OrderLedger (Durable Object, one per order_id)
                                            · dedup on event_id
                                            · state machine + pending buffer
                                            · accrue money, recompute the verdict
                                            · persist, return the new state + version
                                                               │
                                               4. project state → D1      (guarded on version)
                                               5. record the event row    (timeline)

                    ✗ failed every retry ──▶ courier-events-dlq ──▶ DLQ consumer ──▶ D1 dead_letters

Console ──GET /api/orders──────────────────▶ Worker ──▶ D1   (eventually consistent)
        └─GET /api/orders/:id?authoritative ▶ Worker ──▶ DO   (strongly consistent)
```

This is CQRS-lite. The Durable Object is the authoritative write model and D1 is the read
model. Everything below follows from that split.

---

## The three consistency zones

The tempting summary is "it's an AP system", and it's wrong in a useful way. CAP describes what
a *replicated* datastore does when a partition splits its replicas. This ledger isn't
replicated. It's single-writer by construction, one Durable Object per order, so there is no
set of replicas to diverge and no C-versus-A choice to make about it. What the system actually
has is three zones with three different answers, and picking each one was the design work.

| Zone | Consistency | Mechanism |
|---|---|---|
| **1. Ingestion** | Async, tolerates disorder | Queue, at-least-once. `event_id` idempotency plus a pending buffer converge deterministically |
| **2. Reconciliation ledger** | **CP** | One Durable Object per order, single-threaded, so the lost update can't happen |
| **3. Dashboard reads** | **AP** | D1 projection, guarded by a monotonic version |

Zone 1 tolerates disorder in *arrival* and still converges. At-least-once delivery means
duplicates are a certainty rather than a risk, which is what makes the `event_id` key and the
pending buffer load-bearing pieces of the design.

Zone 2 is where the money lives. Two concurrent writers that both read Rs. 1,000 and both add
Rs. 500 produce Rs. 1,500, and one payment silently vanishes. That's the lost update, and it's
the banking-ledger case made literal, so the ledger gets the expensive treatment.

Zone 3 is genuinely AP and the payoff is real. A merchant looking at a dashboard two seconds
stale is fine, because nothing gets decided on that screen. So the dashboard reads a D1
projection, and listing 100 orders costs one indexed query instead of 100 Durable Object round
trips.

What joins zones 2 and 3 is a single guarded statement in `src/projection.ts`:

```sql
UPDATE orders SET ... WHERE order_id = ? AND projection_version < ?
```

A projection write lands only if its version is newer than what the row already holds, so a
late write matches zero rows and disappears. Stale is fine. Rewinding isn't: a merchant who
watches a collected total go *down* has learned not to trust the screen, and that costs more
than two seconds of lag ever saved. The DO recomputes its whole state on every event instead of
emitting deltas, so the write that won already carries everything the dropped one did.

To make the lag visible, `?authoritative=true` reads both zones at once and reports the gap as
`versions_behind`.

---

## Why a Durable Object for the ledger, and why not just D1

Applying a payment is a read-modify-write. Read the current status, the amount collected, and
whether this `event_id` was seen before. Decide whether the event is a duplicate, legal in this
state, or belongs in the pending buffer. Then write the new total, the dedup record, the
history entry and the new verdict. Two events for one order can be processed at the same time
in different queue batches and different isolates, with no coordination between them. If both
read `amount_collected = 1000` before either writes, one payment disappears and nothing reports
an error.

The obvious objection is that D1 is a real database and databases solve this. The strongest
form of it is an atomic increment: `UPDATE orders SET amount_collected = amount_collected + ?
WHERE order_id = ?` really does fix the lost update for pure accrual. It still isn't enough,
because accrual isn't the operation. The operation is *decide, then maybe accrue*, and the
decision reads the dedup set and the pending buffer and determines whether the increment
happens at all. The increment makes one line safe while the decision above it still races.
Closing that gap on D1 means an interactive transaction it doesn't offer, a hand-rolled version
column with a retry loop, or a lease table, all of which exist to simulate serialization on a
system that lacks it. `idFromName(order_id)` maps an order to exactly one globally-unique
object whose requests the platform serialises, so I get serialization for free.

Three costs:

- **You can't query across orders.** A DO knows its own order and nothing else. "Show every
  discrepancy this week" is unanswerable inside the write model, which is why the D1 projection
  exists and why this is CQRS rather than a preference.
- **Per-order throughput is bounded** by one object's single thread. That's correct for a COD
  order, which sees a handful of events in its life, and wrong for a hot global counter.
- **Naming a DO creates it.** A DO for a nonexistent order would spring into being just by
  being addressed, and silently accrue money against an order no merchant can see. So the
  consumer confirms the order in D1 before it ever calls `idFromName`, and
  `npm run assert:no-phantom` checks that.

I didn't use KV for the ledger for a related reason. Eventually consistent by design is a
feature for a like counter and a defect for the field recording how much cash a courier is
holding.

---

## Why a Queue

The webhook could have called the ledger directly and returned when it was done. It doesn't,
and the reason isn't throughput. A courier that waits on our database is a courier that
manufactures duplicates. If the webhook holds the connection open while a Durable Object wakes
and D1 commits, our slowness becomes their timeout, and a timed-out webhook call gets retried
because the caller has no idea whether we processed it. We'd be generating the duplicates we
then spend correctness machinery deduplicating. Returning `202 Accepted` before any storage work
breaks that loop. The webhook does only what has to be synchronous: authenticate, validate the
shape, enqueue. What the queue buys after that is at-least-once delivery (which is why `event_id`
dedup isn't optional), retries with backoff on transient failure (the consumer throws so the
queue retries, and that's safe because the ledger is idempotent), backpressure during a burst,
and a dead-letter queue after `max_retries: 5`. Malformed payloads never enter any of it. They
get a `400` at the webhook and are never enqueued, so the only messages that dead-letter are
ones that were valid and still couldn't be processed.

---

## Why D1 for reads, and a D1 table for the audit log

D1 is the read model because the dashboard's questions are relational and cross-order: every
order for a merchant, newest first; every order currently flagged. That's one indexed query,
where the same question against the write model is 100 Durable Object round trips per refresh
out of a 100,000/day budget.

The raw payloads live in D1 too, in their own `audit` table (`0003`). An object store is the
better long-term home for write-once opaque blobs and that's where I'd put this at real volume
— but at demo volume the row-write cost of storing a payload is negligible, and keeping one
storage primitive was simpler than standing up a second. That's the whole reason, stated
plainly; there's no deeper argument underneath it.

What does still carry weight is that the two are separate **tables**. The audit log holds more
than the timeline can: the write happens *before* the order-existence check, so payloads for an
order that didn't exist yet are still stored, and `order_events` has nowhere to put a row for an
order it can't reference. And `order_events` records the ledger's verdict, while `audit` holds
the verbatim request bytes that verdict was formed from — what we concluded and what we were
sent, kept apart. The audit table is insert-only, `ON CONFLICT(event_id) DO NOTHING`, so a
redelivery rewrites nothing: immutability here is a property of how it's written, not of the
store it's written to.

---

## Reliability primitives

The two sections above already cover fast ack, retries, backpressure and at-least-once
handling. Four more carry their own weight. The **idempotency key** is `event_id`, deduped
inside `OrderLedger`, so a `payment_collected` processed twice never double-counts cash. The
**dead-letter queue** — `courier-events-dlq` and its consumer, writing to `dead_letters` — keeps
one poison message from blocking everything behind it. **Deterministic ordering** comes from the
state machine, the pending buffer and buffer eviction together, so arrival order never decides
the outcome. And the **monotonic projection guard**, `WHERE projection_version < ?`, stops a
late write from rewinding the read model.

---

## What I deliberately didn't use

- **Cloudflare Workflows.** Right for a long-running saga. Each event here is one short unit of
  work whose durability need is already met by queue retries and ledger idempotency.
- **KV for the ledger.** Eventually consistent by design, which is wrong for money-truth.
- **Synchronous webhook processing.** Turns our latency into their timeout and their timeout
  into our duplicates.
- **A real courier API.** I have no Pathao or Aramex access. The simulator sends real HTTP to
  the real webhook, so only the caller is simulated.
- **An external Postgres via Hyperdrive.** Brings back connection pooling and the concurrency
  problem the Durable Object already solves.
- **WebSockets or SSE for the dashboard.** Polling every two seconds makes replication lag
  visible, which is what the demo is about.
- **R2 for the audit log.** The right home for write-once opaque payloads, and where I'd put
  audit at real volume; for a demo I used a D1 table to avoid a second storage primitive.

---

## Key decisions

- **Money is whole NPR integers everywhere.** One `isValidAmount` predicate, no minor units, no
  floats.
- **Overpayment is flagged, never clamped.** The ledger records what happened and the ladder
  decides what it means (`OVERPAID`).
- **An unknown `order_id` takes the orphan path.** The existence check runs before
  `idFromName`, since naming a DO creates it.
- **The projection is a compare-and-set on a monotonic version.** A late write matches zero
  rows and vanishes.
- **`event_id` is the idempotency key.** A repeat returns the verdict it earned the first time,
  increments a delivery count, and moves no money.
- **`0001_init.sql` is frozen and dead-letters shipped as `0002`.** Editing an applied
  migration diverges the file from the live schema.

---

## Schema evolution, and the EDI parallel

The courier event carries a `schema_version` and evolution is additive-only. Adding an optional
field is safe: the validator ignores what it doesn't recognise, and because the webhook carries
the verbatim request bytes through to the audit table instead of re-serialising its parsed view,
a field this build
has never heard of still survives into the audit log intact. Removing or renaming a field is
breaking and needs a version bump with both versions supported during the transition. This is a
small version of the problem EDIFACT and ANSI X12 exist to solve. Two organisations that share
no codebase or release cycle still have to agree on the shape of a message, and the agreement
has to survive one side upgrading first. The courier isn't mine to redeploy.

---

## API surface

Every read names the zone that answered it in a `source` / `consistency` pair on the response
body, so a caller never has to guess whether it's holding truth or a copy.

| Method | Path | Zone | Notes |
|---|---|---|---|
| `GET` | `/health` | — | Status, bindings, and the enum vocabulary the console fetches at boot. |
| `POST` | `/api/orders` | D1 write | Creates the order registry row. `201` + `order_id`. |
| `GET` | `/api/orders` | D1 read (AP) | Dashboard list. `?merchant_id=`, `?limit=` (default 50, max 200). |
| `GET` | `/api/orders/:id` | D1 read (AP) | Order, event timeline, and any orphaned events that named this `order_id` before it existed. |
| `GET` | `/api/orders/:id?authoritative=true` | **DO read (CP)** | The above plus the ledger read directly, and a `divergence` block reporting `versions_behind`. Opt-in, because it costs a DO round trip. |
| `GET` | `/api/orders/:id/audit` | D1 read | Raw payload references from the `audit` table. `?event_id=` returns the stored bytes verbatim. |
| `GET` | `/api/dead-letters` | D1 read (AP) | Messages that failed every retry. |
| `POST` | `/webhook/courier` | Queue producer | Bearer auth, validate, enqueue, `202`. Never touches D1 or the DO. |

---

## Free-tier limits

Everything fits the free plan comfortably: three small row writes per event, about three queue
operations per event, and microseconds of Worker CPU. What binds is the
shared 100,000 requests/day that the Worker and the Durable Objects both spend from, which
makes the dashboard's poll interval a real design parameter — a 1-second poll across 20 open
dashboards is 1.7M requests/day on its own.

---

## Running it

Two terminals. The console is served on a different origin from the API on purpose, so CORS
gets exercised in development instead of discovered at deploy time.

```bash
npm install
npm run db:migrate:local     # apply 0001 + 0002 to the local emulated D1

# terminal 1 — the Worker: API, webhook, queue consumer, DLQ consumer, ledger
npm run dev                  # http://127.0.0.1:8788

# terminal 2 — the console
npm run frontend             # http://127.0.0.1:8789
```

Open **http://127.0.0.1:8789**. `wrangler dev` emulates D1, Queues and Durable Objects
together, so events really do traverse the queue and really are consumed asynchronously.

### Driving the simulator

Create an order in the form on the left, open it from the dashboard, and use the simulator
panel at the top of the detail view. Each button makes real authenticated POSTs to
`/webhook/courier`.

| Button | What to watch |
|---|---|
| **Happy path** | Dispatched, paid in full, delivered. Settles to `FULLY_COLLECTED`. |
| **Send payment twice** | The same `event_id`, twice. Collected must not double. The timeline row reads `applied · ×2`. |
| **Returned before dispatch** | `returned` lands first and shows as `buffered` with money untouched, then `delivery_attempted` arrives and the buffer drains. Both apply in causal order. |
| **Partial payment** | 40% collected. `PARTIALLY_COLLECTED`, and the bar stops short of the expected line. |
| **Custom event** | Any type, amount and `occurred_at`. Useful for building a discrepancy by hand. |
| **Send a poison event** | Carries the reserved `sim-poison` courier id, fails every retry, and about 35 seconds later appears in the dead-letter panel. |

Tick **Compare with the ledger** to read the Durable Object alongside the projection, then fire
a scenario and watch `versions_behind` rise and return to zero.

### Verification scripts

```bash
npm run check              # ladder totality proof + typecheck. No server needed.

# these need `npm run dev` running
npm run verify:convergence # 72 assertions: duplicates, disorder, buffer eviction, projection
npm run verify:ladder      # 28 cells: the ladder is total, all six verdicts reachable
npm run verify:cors        # 33 assertions: CORS logic (a harness, NOT a browser)
npm run verify:dlq         # fires a poison event, watches for the dead-letter hand-off
npm run assert:no-phantom  # an unknown order_id must spawn no ledger
```

### Deploying

```bash
wrangler d1 create cod-recon            # paste the id into wrangler.jsonc
wrangler queues create courier-events
wrangler queues create courier-events-dlq
npm run db:migrate:remote
wrangler secret put COURIER_SHARED_SECRET

npm run deploy                          # the Worker
npm run deploy:frontend                 # the Pages console
```

Then add the console's real `*.pages.dev` origin to `ALLOWED_ORIGINS` in `wrangler.jsonc` and
redeploy the Worker, or the dashboard will load and stay empty.

---

## Honest limitations

- **Durable Object storage grows worse than linearly.** The ledger keeps `processed`, `history`
  and `pending`, and `applyEvent` reads and rewrites all of them on every event, so it's O(n)
  storage and O(n) work per event, O(n²) over an order's life. It doesn't show here, because a
  COD order's whole lifecycle is five to ten events. The fixes (SQLite tables instead of one
  serialised array, expiring `processed`, archiving settled orders) are known and not built.
- **The courier is simulated.** The simulator makes real HTTP calls to the real webhook, so the
  ingestion path is genuine end to end, but the caller is a browser panel.
- **Local emulation only.** No resource has ever been created on a real Cloudflare account.
- **Audit payloads sit in a D1 table, not an object store.** That's the wrong long-term shape
  for write-once blobs — they burn row writes and inflate a relational database with data no
  query filters on — but it's fine at this scale, and it kept the system to one storage
  primitive.
- **It's a demo at the edges.** No merchant auth, no pagination, and the simulator holds the
  courier secret in the browser, so it must never be deployed with a live credential.

---

## Deferred to deploy

Local emulation is faithful enough to prove application logic, but three claims need a real
account to settle: the DLQ hand-off works locally against a queue that is its own
implementation, so Cloudflare's retry backoff won't match the ~36 seconds `verify:dlq` sees;
`verify:cors` sends browser-shaped headers from a script rather than a browser enforcing
same-origin; and the two-consumer projection race the version guard exists for never happens
locally, because batches drain sequentially in one isolate. Remote migrations, resource
creation, `wrangler secret put`, real consumer concurrency, metered usage and Pages itself are
also unexercised.
