# COD Reconciliation Engine

An async trust layer for cash-on-delivery orders in Nepali e-commerce.

A COD order marked `delivered` on one system but `returned` on another. A payment counted
twice because the courier's webhook fired twice. **Reconciliation is the act of arriving at
one true answer.** This system ingests late, out-of-order, duplicated courier events and
converges every order onto a single money-truth.

> **Async at-least-once ingestion → a CP ledger → eventually-consistent reads.**

Everything runs on the Cloudflare **free** plan: Workers, Queues, Durable Objects, D1, R2 and
Pages. Four committed proofs stand behind the claims rather than asserting them in prose:

| | |
|---|---|
| `npm run verify:convergence` | **72 assertions.** A duplicate payment moves money once; `returned` before `delivery_attempted` converges; a held event that becomes impossible is evicted rather than leaked; the projection matches the ledger exactly. |
| `npm run verify:ladder` | **28 cells.** The reconciliation ladder is total — every status × money combination resolves, and all six verdicts are reachable. |
| `npm run verify:cors` | **33 assertions** covering the CORS *logic*, including the negative cases. A harness, not a browser. |
| `npm run verify:dlq` | Fires a real poison event and watches for the dead-letter hand-off. |

**One caveat, stated once and not repeated below: everything here is verified against local
emulation only.** No Cloudflare resource has ever been created. [Deferred to
deploy](#deferred-to-deploy) names exactly which claims that leaves unsettled.

---

## What it does

A merchant books a COD order for Rs. 1,500. A courier goes out and, over the next hours,
reports what happened — dispatched, collected, delivered, returned. Those reports arrive
**late, out of order, and sometimes twice**, because that is what third-party webhooks do. The
system ingests them, converges each order onto one money-truth, and shows the merchant which
orders have a problem.

The two demos worth watching are the two that break naive systems.

**Send the same `payment_collected` twice.** A courier whose webhook call timed out retries it.
Both deliveries are real HTTP requests carrying the same `event_id`. The ledger applies the
first, recognises the second, and **moves money once** — the timeline row reads `applied · ×2`
next to an unchanged total. A system that trusted its inbox would have booked Rs. 3,000 against
a Rs. 1,500 order and flagged the merchant's own customer for overpayment.

**Send `returned` before `delivery_attempted`.** The order has not been dispatched, so
`returned` is illegal — and also perfectly plausible, because the dispatch event is presumably
still in flight. The ledger **holds** it, the timeline shows `buffered`, and no money moves.
When `delivery_attempted` lands, the buffer drains and both events apply **in causal order
rather than arrival order**, converging on the same answer the ledger would have reached had
the courier called in sequence.

Both are drivable from the console's simulator panel, which makes real authenticated POSTs to
the courier webhook — not internal fake-firing. A third button sends a deliberately poisonous
event, to show a bad message being set aside instead of blocking the pipeline.

---

## Architecture

```
Merchant ──POST /api/orders──▶ Worker ──▶ D1 (order registry, status=PENDING)
                                     └──▶ (the ledger DO is created lazily, by the first event)

Courier ──POST /webhook/courier──▶ Worker ──auth, validate──▶ Queue   (202, fast ack)
                                                               │
                                                               ▼
                                             Queue consumer (Worker)
                                               1. raw payload → R2        (audit, always first)
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

This is **CQRS-lite**. The Durable Object is the authoritative **write model**; D1 is the
**read model**. Everything below follows from that split.

---

## The three consistency zones

The tempting summary is "it's an AP system", and it would be wrong in an instructive way. CAP
describes what a *replicated datastore* does when a partition splits its replicas. This ledger
is not replicated — it is single-writer by construction, one Durable Object per order. There
is no set of replicas to diverge, so there is no C-versus-A choice to make about it. The honest
framing is that the system has **three zones with deliberately different postures**, and the
design work was choosing each one rather than inheriting a single answer.

| Zone | Posture | Mechanism | What it refuses to do |
|---|---|---|---|
| **1. Ingestion** | Async, disorder-tolerant | Queue, at-least-once; `event_id` idempotency + a pending buffer converge deterministically | Refuses to make the courier wait |
| **2. Reconciliation ledger** | **CP** | One Durable Object per order — single-threaded, so the lost update is structurally impossible | Refuses to be fast at the cost of being wrong |
| **3. Dashboard reads** | **AP** | D1 projection, guarded by a monotonic version | Refuses to pay for strong reads nobody needs |

**Zone 1 is not "relaxed about correctness".** It tolerates disorder *in arrival* and converges
deterministically regardless; those are different things. At-least-once delivery means
duplicates are not a risk to be mitigated but a **certainty to be designed for**, which is what
makes the `event_id` idempotency key and the pending buffer load-bearing rather than defensive.

**Zone 2 is where the money lives, so it gets the expensive posture.** Two concurrent writers
that both read Rs. 1,000 and both add Rs. 500 produce Rs. 1,500, and one payment silently
vanishes. That is the lost update, and it is the banking-ledger case made literal — so the
ledger gets a posture that makes it impossible rather than unlikely.

**Zone 3 is genuinely AP, and the payoff is real.** A merchant looking at a dashboard two
seconds stale is fine; nothing is decided on that screen. So the dashboard reads a D1
projection, and listing 100 orders costs one indexed query instead of 100 Durable Object round
trips. That is the like-counter tolerance honestly applied: find what does not need to be
strongly consistent and stop paying for it.

The seam between zones 2 and 3 is one guarded statement (`src/projection.ts`), and it is what
keeps "eventually consistent" from degrading into "sometimes wrong":

```sql
UPDATE orders SET ... WHERE order_id = ? AND projection_version < ?
```

A projection write lands only if its version is newer than what the row already holds, so a
late write matches zero rows and disappears. **Stale is acceptable; rewinding is not** — a
merchant who watches a collected total go *down* has learned not to trust the screen, and that
costs more than the two seconds of lag ever saved. Because the DO recomputes its entire state
on every event rather than emitting deltas, the write that won already carries everything the
dropped one did.

And because "eventually" should be shown rather than asserted, `?authoritative=true` reads both
zones at once and reports the gap as `versions_behind`. Lag stops being a paragraph in a README
and becomes a number you watch return to zero.

---

## Why a Durable Object for the ledger — and why not just D1

Applying a payment is not a write. It is a **read-modify-write**: read the current status,
amount collected, and whether this `event_id` was seen before; decide whether the event is a
duplicate, legal in this state, or belongs in the pending buffer; then write the new total, the
dedup record, the history entry and the new verdict. Two events for one order can be processed
concurrently — different queue batches, different isolates, no coordination — and if both read
`amount_collected = 1000` before either writes, one payment disappears and nothing reports an
error.

The obvious objection is that D1 is a real database and databases solve this. The strongest
version of it is an atomic increment: `UPDATE orders SET amount_collected = amount_collected + ?
WHERE order_id = ?` genuinely does fix the lost update for pure accrual, because the read and
the write cannot interleave. **It is not enough, because accrual is not the operation.** The
operation is *decide, then maybe accrue* — and the decision reads the dedup set and the pending
buffer, and determines whether the increment happens at all. An atomic increment makes one
*line* safe while the decision above it still races. Closing that gap on D1 means an interactive
transaction it does not offer (its batch API groups statements you have already decided on), or
a hand-rolled version column with a retry loop, a backoff policy and a bound on attempts —
contention being worst exactly when a burst arrives for one hot order — or a lease table, which
is a distributed lock manager underneath a demo's payment ledger. Every one of those exists to
*simulate* serialization on a system that lacks it. `idFromName(order_id)` maps an order to
exactly one globally-unique object whose requests the platform serialises, so the ledger has
serialization natively and none of that machinery is written, tuned, or a source of bugs.
Serialization is free; everything else costs.

Three costs, stated plainly:

- **You cannot query across orders.** A DO knows its own order and nothing else. "Show every
  discrepancy this week" is unanswerable inside the write model — which is precisely why the
  D1 projection exists, and why this is CQRS rather than a preference.
- **Per-order throughput is bounded** by one object's single thread. Correct for this domain,
  where an order sees a handful of events in its life; wrong for a hot global counter.
- **Naming a DO creates it.** A DO for a nonexistent order would spring into being just by
  being addressed, silently accruing money against an order no merchant can see. The consumer
  therefore confirms the order in D1 *before* it ever touches `idFromName`, and
  `npm run assert:no-phantom` asserts that rather than trusting it.

Not KV, for the same reason: eventually consistent by design is a feature for a like counter
and a defect for the field recording how much cash a courier is holding.

---

## Why a Queue

The webhook could have called the ledger directly and returned when it was done. It does not,
and the reason is not throughput: **a courier that waits on our database is a courier that
manufactures duplicates.** If the webhook holds the connection open while a Durable Object
wakes and D1 commits, our slowness becomes their timeout — and a timed-out webhook call gets
retried, because the caller has no idea whether we processed it. We would be *generating* the
duplicates we then spend correctness machinery deduplicating. Answering `202 Accepted` in
milliseconds breaks that loop at the source. So the webhook does only what must be synchronous
— authenticate, validate the shape, enqueue — and everything expensive happens on the far side.
What follows is at-least-once delivery (duplicates are the contract, which is what makes
`event_id` dedup non-optional), retries with backoff on transient failure (the consumer
*throws* so the queue retries, and the retry is safe only because the ledger is idempotent),
backpressure during a burst, and a dead-letter queue after `max_retries: 5` so one poison
message cannot occupy the retry budget forever. Malformed payloads never enter any of this:
they are rejected at the webhook with a `400` and never enqueued, so the only things that
dead-letter are messages that were *valid* and still could not be processed.

---

## Why D1 for reads, and R2 for the audit log

Three stores, three genuinely different shapes of data. **D1 is the read model** because the
dashboard's questions are relational and cross-order — every order for a merchant, newest
first; every order currently flagged — and that is one indexed query, where the same question
against the write model is 100 Durable Object round trips per refresh out of a 100,000/day
budget. **R2 is the audit log** because raw courier payloads are immutable opaque blobs,
addressed by key and almost never read: `events/{order_id}/{event_id}.json`, write-once, free
egress. They are *evidence*, not data. Swapping them would be wrong in both directions —
payloads in D1 would burn row writes on something no query filters on, and a projection in R2
would mean listing and parsing every object to render one table. The audit log also does two
things the D1 timeline structurally cannot: it is **wider**, because the R2 write happens
*before* the order-existence check, so payloads for an order that did not exist yet are stored
even though the ledger never saw them; and it is **uninterpreted**, because `order_events`
records the ledger's verdict while R2 holds the verbatim request bytes that verdict was formed
from — including fields from a future schema version this build does not understand.

---

## Reliability primitives

Each of these is a specific mechanism in the code, not a posture.

| Primitive | Where it lives | The failure it prevents |
|---|---|---|
| **Idempotency key** | `event_id` dedup in `OrderLedger` | The crown jewel. A `payment_collected` processed twice would double-count cash. This is the duplicate-charge problem reproduced inside our own system, and the reason at-least-once delivery is survivable at all. |
| **At-least-once handling** | Consumer + ledger are both idempotent | A redelivered message re-runs the whole pipeline safely: the DO returns the verdict the event earned the first time, and the projection's version guard drops the stale write. |
| **Retry on transient failure** | `message.retry()` in `consumeBatch` | A D1 hiccup silently losing a courier event. The consumer throws rather than swallowing, so the queue retries with backoff. |
| **Dead-letter queue** | `courier-events-dlq` + its own consumer → `dead_letters` | One poison message consuming the retry budget forever and blocking everything behind it. The DLQ's job is not to fix the message; it is to get it out of the way while keeping it findable. |
| **Fast ack** | `202` from the webhook before any storage work | Our latency becoming the courier's timeout, and their retry becoming our duplicate. |
| **Backpressure** | The queue itself; consumer concurrency as the knob | A burst of events landing directly on the ledger. Buffered instead, and drained at a rate we choose. |
| **Deterministic ordering** | State machine + pending buffer + eviction | Arrival order deciding the outcome. The ledger converges on causal order regardless of arrival sequence — and the buffer only ever holds events with a future. |
| **Monotonic projection guard** | `WHERE projection_version < ?` | A late projection write rewinding the read model, so a merchant watches the collected total go backwards. |
| **Schema versioning** | `schema_version`, additive-only; raw bytes preserved in R2 | A new optional field from the courier breaking ingestion, or being silently discarded on the way to the audit log. |

---

## What I deliberately didn't use

- **Cloudflare Workflows.** Right for a long-running saga; each event here is one short unit of
  work whose durability need is already met by queue retries and ledger idempotency.
- **KV for the ledger.** Eventually consistent by design — wrong for money-truth.
- **Synchronous webhook processing.** Converts our latency into their timeout, and their
  timeout into our duplicates.
- **A real courier API.** No Pathao or Aramex access; the simulator sends real HTTP to the real
  webhook, so the ingestion path is genuine and only the caller is simulated.
- **An external Postgres via Hyperdrive.** Reintroduces connection pooling and the same
  concurrency problem the Durable Object solves structurally.
- **WebSockets or SSE for the dashboard.** Polling every two seconds makes replication lag
  visible, which is the thing the demo is about; a pushed dashboard would hide it.

---

## Key decisions

- **Money is whole NPR integers, everywhere** — one `isValidAmount` predicate, no minor units,
  no floats.
- **Overpayment is flagged, never clamped** — the ledger records what happened, and the ladder
  decides what it means (`OVERPAID`).
- **An unknown `order_id` takes the orphan path, never a phantom ledger** — the existence check
  precedes `idFromName`, because naming a DO is what creates it.
- **The projection is a compare-and-set on a monotonic version** — a late write matches zero
  rows and vanishes; the read model never rewinds.
- **`event_id` is the idempotency key** — a repeat returns the verdict it earned the first time
  and increments a delivery count, and moves no money.
- **`0001_init.sql` is frozen; dead-letters shipped as `0002`** — editing an applied migration
  silently diverges the file from the live schema, and the habit only survives if it starts
  before it is expensive.

---

## Schema evolution, and the EDI parallel

The courier event carries a `schema_version`, and evolution is **additive-only**. Adding an
optional field is safe: the validator ignores what it does not recognise, and because the
webhook writes the **verbatim request bytes** to R2 rather than re-serialising its parsed view,
a field this build has never heard of still survives into the audit log intact. Removing or
renaming a field is breaking, and needs a version bump with both versions supported during the
transition. This is a small instance of the problem EDIFACT and ANSI X12 exist to solve: two
organisations that share no codebase, release cycle or deployment window still have to agree on
the shape of a message, and the agreement has to survive one side upgrading first. The parallel
is narrow but real, and worth naming because it explains why "just add the field, everyone will
redeploy" is not available here — the courier is not ours to redeploy.

---

## API surface

Every read names the zone that answered it, in a `source` / `consistency` pair on the response
body. A caller should never have to guess whether it is holding truth or a copy.

| Method | Path | Zone | Notes |
|---|---|---|---|
| `GET` | `/health` | — | Status, bindings, and the enum vocabulary the static console fetches at boot. |
| `POST` | `/api/orders` | D1 write | Creates the order registry row. `201` + `order_id`. |
| `GET` | `/api/orders` | D1 read (AP) | Dashboard list. `?merchant_id=`, `?limit=` (default 50, max 200). |
| `GET` | `/api/orders/:id` | D1 read (AP) | Order, event timeline, and any orphaned events that named this `order_id` before it existed. |
| `GET` | `/api/orders/:id?authoritative=true` | **DO read (CP)** | The above *plus* the ledger read directly, and a `divergence` block reporting `versions_behind`. Opt-in, because it costs a DO round trip. |
| `GET` | `/api/orders/:id/audit` | R2 list | Raw payload references. `?event_id=` returns the stored bytes verbatim. |
| `GET` | `/api/dead-letters` | D1 read (AP) | Messages that failed every retry and were moved to `courier-events-dlq`. |
| `POST` | `/webhook/courier` | Queue producer | Bearer auth, validate, enqueue, `202`. Never touches D1 or the DO. |

---

## Free-tier limits

| Primitive | Free-plan limit | What this system spends |
|---|---|---|
| **Workers** | 100,000 requests/day; 10 ms CPU per invocation | Webhook validates and enqueues — microseconds of CPU. Dashboard polling is the volume driver. |
| **Durable Objects** | 100,000 requests/day; 13,000 GB-s/day; 5 GB SQLite storage | One request per courier event, plus one per authoritative read — drawn from the *same* pool the Worker spends from. This is the ceiling that binds. |
| **Queues** | 10,000 operations/day; 24-hour retention | ~3 ops per event (write, read, delete) → ~3,300 events/day. A poison event costs ~9–10, across six attempts plus the DLQ hand-off. |
| **D1** | 5 GB storage; 5M rows read/day; 100k rows written/day | Two row writes per event: the guarded projection, and the timeline row. |
| **R2** | 10 GB-month; 1M Class A ops/month; 10M Class B; free egress | One small JSON write per event received. The cheapest part of the system. |
| **Pages** | Unlimited requests and bandwidth; 500 builds/month | Static console. Never a constraint. |

The binding constraint is the shared 100,000 requests/day, and **poll interval is a real design
parameter because of it** — a 1-second poll across 20 open dashboards is 1.7M requests/day and
blows the plan on its own, while the ledger it is watching stays comfortably inside every other
limit.

---

## Running it

Two terminals. The console is served on a **different origin** from the API on purpose, so CORS
is exercised in development rather than discovered at deploy time.

```bash
npm install
npm run db:migrate:local     # apply 0001 + 0002 to the local emulated D1

# terminal 1 — the Worker: API, webhook, queue consumer, DLQ consumer, ledger
npm run dev                  # http://127.0.0.1:8788

# terminal 2 — the console
npm run frontend             # http://127.0.0.1:8789
```

Open **http://127.0.0.1:8789**. `wrangler dev` emulates D1, R2, Queues and Durable Objects
together, so events really do traverse the queue and really are consumed asynchronously.

### Driving the simulator

Create an order in the form on the left, open it from the dashboard, and use the simulator
panel at the top of the detail view. Each button makes real authenticated POSTs to
`/webhook/courier`.

| Button | What to watch |
|---|---|
| **Happy path** | Dispatched → paid in full → delivered. Settles to `FULLY_COLLECTED`. |
| **Send payment twice** | The same `event_id`, twice. **Collected must not double.** The timeline row reads `applied · ×2`. |
| **Returned before dispatch** | `returned` lands first and shows as `buffered`, money untouched; then `delivery_attempted` arrives and the buffer drains. Both apply, in causal order. |
| **Partial payment** | 40% collected. `PARTIALLY_COLLECTED`, and the bar stops short of the expected line. |
| **Custom event** | Any type, amount and `occurred_at`. Useful for building a discrepancy by hand. |
| **Send a poison event** | Carries the reserved `sim-poison` courier id, fails every retry, and ~35 seconds later appears in the dead-letter panel. |

Tick **Compare with the ledger** to read the Durable Object directly alongside the projection.
Fire a scenario with it on and watch `versions_behind` rise and return to zero.

### Verifying it rather than trusting it

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
wrangler r2 bucket create cod-recon-audit
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

- **Durable Object storage grows without bound, and worse than linearly.** The ledger keeps
  `processed`, `history` and `pending`, and `applyEvent` reads and rewrites all of them on every
  event — O(n) storage and O(n) work per event, so O(n²) over an order's life. Invisible here,
  because a COD order's whole lifecycle is five to ten events; it would matter for a
  differently-shaped key, and the fixes (SQLite tables instead of one serialised array, expiring
  `processed` past the queue's 24-hour retention, archiving settled orders) are known and
  deliberately not built.
- **The courier is simulated.** The simulator makes real HTTP calls to the real webhook, so the
  ingestion path is genuine end to end — but the caller is a browser panel, not a logistics
  company.
- **Local emulation only.** No resource has ever been created on a real Cloudflare account; the
  next section lists what that leaves unsettled.
- **It is a demo at the edges**: no merchant auth, no pagination, and the simulator holds the
  courier secret in the browser — it stands in for the courier's own server, and must never be
  deployed with a live credential.

---

## Deferred to deploy

Local emulation is faithful enough to prove application logic, and everything above has been
proven that way — but it is a simulation of the platform, not the platform. Four claims are
specifically the ones it cannot settle, and they are reasoned rather than run: the **DLQ
hand-off** is demonstrated locally (`verify:dlq` shows six attempts and a `dead_letters` row
~36 s later), but the local queue is its own implementation of the behaviour, not the
production scheduler; **retry backoff timing** is scheduled by Cloudflare and will not match
the ~36 s seen here; **browser CORS** is proven as *logic* by a harness that sends
browser-shaped headers, which is not a browser enforcing a same-origin policy; and **the
two-consumer projection race** the version guard exists for never happens locally at all,
because local batches drain sequentially in one isolate — the guard is proven correct, but its
necessity is reasoned from the execution model rather than observed. Also unexercised until
then: remote migrations, resource creation, `wrangler secret put`, real batching and consumer
concurrency, metered free-tier usage, and Pages itself (the console is three static files with
no `functions/` directory and no bindings, which is why a static stand-in is honest here).

---

## Appendix: course-concept coverage

| Day | Concept | Where it is in this system |
|---|---|---|
| **1** | Compute, queue, database, object store | Worker, Queues, D1, R2 — all four, each doing the job it is actually for |
| 1 | Fire-and-forget | The webhook answers `202` and hands off; the courier never waits on our storage |
| 1 | "Different data, different shape" | Opaque payload bytes in R2, relational projection in D1, keyed authoritative state in a DO — [three stores, three shapes](#why-d1-for-reads-and-r2-for-the-audit-log) |
| **2** | Serverless vs server | Workers throughout (the Lambda-family model); nothing provisioned, per-request billing |
| 2 | Stateless vs stateful | Stateless Workers everywhere except the one place state needs an address — the ledger DO |
| 2 | CPU-bound vs IO-bound | The consumer is IO-bound: four network waits, almost no compute. Why the 10 ms CPU cap is not the constraint |
| 2 | Concurrency | Consumer concurrency is the throughput knob *across* orders; within one order the DO serialises regardless |
| **3** | CAP — and its limits | [Three consistency zones](#the-three-consistency-zones), plus why "the app is AP" would be a category error |
| 3 | Banking ledger (CP) | The `OrderLedger` Durable Object — money-truth gets the strong posture |
| 3 | Like counter (AP) | Dashboard reads from the D1 projection; two seconds stale is fine and cheaper |
| 3 | Isolation / lost update | [Why a Durable Object, and why not just D1](#why-a-durable-object-for-the-ledger--and-why-not-just-d1) |
| 3 | CQRS | DO = write model, D1 = read model, `src/projection.ts` = the seam |
| **4** | Sync vs async | Validate synchronously, do everything expensive on the far side of the queue |
| 4 | Idempotency keys | `event_id` dedup in the ledger — the crown jewel, and what makes retries safe |
| 4 | Retries | Consumer throws on transient failure so the queue retries with backoff |
| 4 | At-least-once | The queue's contract; duplicates are a certainty designed for, not a risk mitigated |
| 4 | Dead-letter queue | `courier-events-dlq` + its own consumer + the `dead_letters` table; `npm run verify:dlq` |
| 4 | Backpressure | The queue absorbs bursts; concurrency is the tuning knob, with its tradeoff named |
| 4 | Schema evolution | Versioned, additive-only events; verbatim bytes preserved to R2 — [and the EDI parallel](#schema-evolution-and-the-edi-parallel) |

---

## Layout

```
src/index.ts                  Worker entry: router, CORS, both queue consumers
src/consumer.ts               Main consumer — R2 audit, orphan path, ledger call, event rows
src/projection.ts             The CQRS seam — version-guarded DO state → D1
src/dead-letters.ts           DLQ consumer — records poison messages in D1
src/durable-objects/          OrderLedger — the CP write model, dedup + state machine + buffer

src/api/orders.ts             Merchant order API + the projected-vs-authoritative read
src/api/webhook.ts            POST /webhook/courier — auth, validate, enqueue, 202
src/api/audit.ts              GET /api/orders/:id/audit — raw payload refs from R2
src/api/dead-letters.ts       GET /api/dead-letters — the poison pile

src/shared/constants.ts       Single source of truth: units, enums, derived unions
src/shared/reconciliation.ts  The total ladder (pure function, no I/O)
src/shared/types.ts           CourierEvent, QueuedCourierEvent, LedgerState
src/shared/validate-event.ts  Webhook validation — forward-compatible by design
src/shared/cors.ts            Allowlist, preflight, Vary: Origin

migrations/0001_init.sql      D1 schema — orders, order_events, orphan_events. FROZEN
migrations/0002_dead_letters.sql  The dead-letter landing table

frontend/public/index.html    Console markup — dashboard, order form, order detail
frontend/public/app.js        Console behaviour — polling, routing, rendering
frontend/public/simulator.js  The courier simulator — real POSTs to the real webhook

scripts/verify-ladder.ts      Ladder totality proof (no server needed)
scripts/verify-convergence.mjs  Duplicates, disorder, buffer eviction, projection convergence
scripts/verify-cors.mjs       Every console request replayed with browser headers
scripts/verify-dlq.mjs        Poison event → dead-letter hand-off
scripts/assert-no-phantom-ledger.mjs  An unknown order_id must spawn no ledger
scripts/serve-frontend.mjs    Static server for the console, on its own origin
```
