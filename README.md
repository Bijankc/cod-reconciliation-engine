# COD Reconciliation Engine

An async trust layer for cash-on-delivery orders in Nepali e-commerce.

A COD order marked `delivered` on one system but `returned` on another. A payment counted
twice because the courier's webhook fired twice. **Reconciliation is the act of arriving at
one true answer.** This system ingests late, out-of-order, duplicated courier events and
converges every order onto a single money-truth.

> **Async AP ingestion → CP ledger → eventually-consistent reads.**

**Build status: complete.** All six phases — scaffold and schema, the merchant order API, the
webhook → queue → R2 audit path, the `OrderLedger` Durable Object, the version-guarded
projection into D1, the console, the courier simulator, and a working dead-letter queue.

Four committed proofs stand behind the claims, rather than assertions in prose:

| | |
|---|---|
| `npm run verify:convergence` | **72 assertions.** A duplicate payment moves money once; `returned` before `delivery_attempted` converges; a held event that becomes impossible is evicted rather than leaked; the projection matches the ledger exactly. |
| `npm run verify:ladder` | **28 cells.** The reconciliation ladder is total — every status × money combination resolves, and every verdict is reachable. |
| `npm run verify:cors` | **33 assertions** covering the CORS *logic*, including the negative cases. Not a browser — see Decision 12 for exactly what that does and does not prove. |
| `npm run verify:dlq` | Fires a real poison event and watches for the dead-letter hand-off. |

**Everything here is verified against local emulation only.** No Cloudflare resource has ever
been created. [Deferred to deploy](#deferred-to-deploy-not-yet-verified-against-real-resources)
lists precisely which claims that leaves unsettled.

---

## What it does

A merchant books a COD order for Rs. 1,500. A courier goes out, and over the next hours
reports what happened — dispatched, collected, delivered, returned. Those reports arrive
**late, out of order, and sometimes twice**, because that is what webhooks from a third party
do. The system ingests them, converges each order onto one money-truth, and shows the
merchant which orders have a problem.

The two things worth watching are the two that break naive systems:

**Send the same `payment_collected` twice.** A courier whose webhook call timed out retries
it. Both deliveries are real HTTP requests carrying the same `event_id`. The ledger applies
the first, recognises the second, and **moves money once** — the timeline row reads
`applied · ×2` next to an unchanged total. A system that trusted its inbox would have
recorded Rs. 3,000 against a Rs. 1,500 order and flagged the merchant's own customer for
overpayment.

**Send `returned` before `delivery_attempted`.** The order has not been dispatched yet, so
`returned` is illegal — and also perfectly plausible, because the dispatch event is presumably
still in flight. The ledger **holds** it, the timeline shows `buffered`, and no money moves.
When `delivery_attempted` finally lands, the buffer drains and both events apply **in causal
order rather than arrival order**. The ledger converges to the same answer it would have
reached had the courier called us in the right sequence.

Both are drivable from the console's simulator panel, which makes real authenticated POSTs to
the courier webhook — not internal fake-firing. There is a third button that sends a
deliberately poisonous event, to show a bad message being set aside instead of blocking the
pipeline.

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

The tempting one-line summary is "it's an AP system". That would be wrong, and wrong in an
instructive way. **CAP describes what a replicated datastore does when a partition splits its
replicas.** This ledger is not replicated — it is single-writer by construction, one Durable
Object per order. There is no set of replicas to diverge, so there is no C-versus-A choice to
make about it. Calling the whole application "AP" would be applying a datastore property to
an architecture.

The honest framing is that this system has **three zones, each with a deliberately different
posture**, and the design work was choosing each one rather than inheriting a single answer.

| Zone | Posture | Mechanism | What it refuses to do |
|---|---|---|---|
| **1. Ingestion** | Async, disorder-tolerant | Queue, at-least-once; idempotency keys + a pending buffer converge deterministically | Refuses to make the courier wait |
| **2. Reconciliation ledger** | **CP** | One Durable Object per order — single-threaded, so the lost update is structurally impossible | Refuses to be fast at the cost of being wrong |
| **3. Dashboard reads** | **AP** | D1 projection, guarded by a monotonic version | Refuses to pay for strong reads nobody needs |

**Zone 1 is not "relaxed about correctness".** It tolerates disorder *in arrival* and
converges deterministically regardless. Those are different things. The queue guarantees
at-least-once delivery, which means duplicates are not a risk to be mitigated — they are a
**certainty to be designed for**. The `event_id` idempotency key and the state machine's
pending buffer are what turn a disordered stream into one deterministic answer.

**Zone 2 is where the money lives, so it gets the expensive posture.** Payment state is
money-truth: two concurrent writes that both read Rs. 1,000 and both add Rs. 500 produce
Rs. 1,500, and one payment silently vanishes. That is the lost update, and it is the
banking-ledger case study made literal. The next section is about why a Durable Object rather
than a lock.

**Zone 3 is genuinely AP, and that is a real choice with a real payoff.** A merchant looking
at a dashboard that is two seconds stale is fine — nothing is decided on that screen, and
nobody's cash position changes because a number arrived late. So the dashboard reads a D1
projection, and a list of 200 orders costs one indexed query instead of 200 Durable Object
round trips. This is the like-counter tolerance, honestly applied: identify what does not
need to be strongly consistent and stop paying for it.

The seam between zones 2 and 3 is one guarded statement (`src/projection.ts`), and it is what
keeps "eventually consistent" from degrading into "sometimes wrong". A projection write lands
only if its version is newer than what the row already holds, so a late write cannot rewind
the read model. **Stale is acceptable; rewinding is not** — a merchant watching a collected
total go *down* has learned not to trust the screen, and that costs more than the two seconds
of lag ever saved.

And because "eventually" is a promise the system should be able to show rather than assert,
`?authoritative=true` reads both zones at once and reports the gap as a number:
`versions_behind`. Lag stops being a paragraph in a README and becomes something you watch
return to zero.

> **Async, at-least-once ingestion → a CP ledger → eventually-consistent reads.**

---

## Why a Durable Object for the ledger — and why not just D1

This is the load-bearing decision in the system, so here is the argument in full, including
the strongest version of the case against it.

### The problem

Applying a payment is not a write. It is a **read-modify-write**:

```
read   current status, amount_collected, and whether this event_id was seen before
decide is this event legal in this state? is it a duplicate? does it accrue?
write  new amount_collected, the dedup record, the history entry, the new verdict
```

Two courier events for the same order can be processed concurrently — different queue
batches, different isolates, no coordination between them. If both read `amount_collected =
1000` before either writes, both compute `1500`, and the second write silently destroys the
first. **One payment disappears, and nothing anywhere reports an error.** The books are wrong
and the system is confident.

### Why "just use D1" does not settle it

The obvious objection is that D1 is a real database and databases solve this. Taking that
seriously, one option at a time:

**"Use an atomic increment."**
```sql
UPDATE orders SET amount_collected = amount_collected + ? WHERE order_id = ?
```
This genuinely does fix the lost update for pure accrual — the read and the write happen
inside one statement and cannot interleave. **It is the strongest counter-argument and it is
not enough**, because accrual is not the operation. The operation is *decide, then maybe
accrue*: is this event a duplicate, is it legal from the current status, does it belong in the
pending buffer, and does applying it drain other events that were waiting? That decision reads
the dedup set and the buffer, and its outcome determines whether the increment happens at all.
An atomic increment makes one *line* safe while the decision above it still races.

**"Wrap it in a transaction."** This is the right instinct, and it needs an *interactive*
transaction — `BEGIN`, read, run application logic, write, `COMMIT` — holding isolation across
a round trip while the Worker thinks. D1 does not offer that. Its batch API is a set of
statements submitted together, which is fine for grouping writes you have already decided on,
and no help at all when the decision itself is the thing that must not interleave.

**"Use optimistic concurrency."** Add a version column, `UPDATE ... WHERE version = ?`, and
retry on zero rows changed. This *works*. It is also the point where you have hand-rolled a
concurrency-control system: a retry loop, a backoff policy, a bound on attempts, and a
decision about what to do when the bound is hit. Every retry is another network round trip,
and contention is worst exactly when a burst of events arrives for one hot order — the moment
you least want a retry storm.

**"Use a lock."** SQLite over HTTP has no row lock you can acquire and hold across a round
trip. Building one means a lease table, lease expiry, and a story for the Worker that dies
holding a lease. That is a distributed lock manager, which is a genuinely hard thing to get
right and an unreasonable thing to put underneath a demo's payment ledger.

### What the Durable Object does instead

`idFromName(order_id)` maps an order to exactly one object, globally. That object is
**single-threaded**: its requests are serialised by the platform, so two events for one order
cannot interleave, and there is nothing to configure to make that true.

The lost update is not *defended against* here. It is **structurally impossible** — there is
no interleaving for it to occur in. All the machinery above (retry loops, version columns,
lease tables) exists to simulate serialization on a system that does not have it. The DO has
it natively, so that machinery is not written, not tuned, and not a source of bugs.

That is the whole trade: **serialization is free, and everything else costs.**

### What it costs, honestly

- **You cannot query across orders.** A DO knows its own order and nothing else. "Show every
  discrepancy this week" is unanswerable inside the write model — which is precisely why the
  D1 projection exists, and why this is CQRS rather than a preference.
- **Per-order throughput is bounded** by one object's single thread. Correct for this domain —
  an order receives a handful of events in its lifetime — and it would be the wrong shape for
  a hot global counter, where every write hitting one object makes it the bottleneck.
- **It is another component**, with its own failure mode: a DO for a nonexistent order would
  be brought into being just by naming it, silently accruing money against an order no
  merchant can see. That is Decision 5, and `npm run assert:no-phantom` asserts it never
  happens rather than trusting that it does not.
- **Its storage grows unbounded** in this implementation. See [Honest
  limitations](#honest-limitations) — this one is real and named, not hidden.

### Why not KV

KV is eventually consistent by design. For a like counter that is a feature; for the field
that says how much cash a courier is holding, a read that might be stale is a read that might
double-count a payment. Wrong tool, and wrong in the specific way that costs money.

---

## Why a Queue

The webhook could have called the ledger directly and returned when it was done. It does not,
and the reason is not throughput.

**A courier that waits on our database is a courier that manufactures duplicates.** If the
webhook holds the connection open while a Durable Object wakes and D1 commits, then any
slowness on our side becomes a timeout on theirs — and a timed-out webhook call gets retried,
because the caller has no idea whether we processed it. We would be *generating* the exact
duplicate events we then have to spend correctness machinery deduplicating. Answering `202
Accepted` in milliseconds breaks that loop at the source.

So the webhook does the minimum that must be synchronous — authenticate, validate the shape,
enqueue — and everything expensive happens on the other side of the queue. Four properties
follow:

- **At-least-once delivery.** The queue will sometimes deliver a message twice. This is not a
  defect to work around; it is the contract, and it is what makes `event_id` dedup
  non-optional rather than defensive.
- **Retries with backoff.** A transient D1 or R2 failure should not lose a courier event. The
  consumer *throws* on transient failure precisely so the queue retries it — and the retry is
  safe only because the ledger is idempotent. Idempotency is what buys the right to retry.
- **A dead-letter queue.** A message that fails every attempt is poison, and retrying it
  forever means it occupies retry budget and blocks the good messages behind it. After five
  attempts it moves to `courier-events-dlq` and stops being the pipeline's problem.
- **Backpressure.** A burst of events is absorbed by the queue rather than by the ledger.
  Consumer concurrency is the tuning knob, and it has a real tradeoff: raising it processes
  more orders in parallel, but events for a *single* order still serialise at that order's
  Durable Object, so concurrency buys throughput across orders and nothing within one.

**Malformed payloads are rejected at the webhook with a `400` and never enqueued.** The queue
is for events already judged well-formed, so a garbage payload can never consume retry budget
or reach the DLQ. The only things that dead-letter are messages that were *valid* and still
could not be processed — which is what makes the DLQ meaningful rather than a junk drawer.

---

## Why D1 for reads, and R2 for the audit log

Three stores, three genuinely different shapes of data. The system would work worse with any
two of them merged.

**D1 is the read model** because the dashboard's questions are relational and cross-order:
every order for a merchant, newest first; every order currently flagged. That is one indexed
query. The same question against the write model is 200 Durable Object round trips, which is
not a performance detail — it is 200 requests out of a 100,000/day budget, per refresh.

**R2 is the audit log** because raw courier payloads are immutable opaque blobs, addressed by
key and almost never read. `events/{order_id}/{event_id}.json`, write-once, free egress. They
are *evidence*, not data: nobody queries inside them, and their value is that they are the
untouched bytes we actually received.

Putting the payloads in D1 instead would pay a row write and consume the row-write budget for
something no query will ever filter on. Putting the projection in R2 would mean listing and
parsing every object to render one table. **Different data, different shape** — an object
store is right for opaque bytes and wrong for questions; a relational store is the reverse.

The audit log also does something the timeline structurally cannot: it is **wider**. The R2
write happens *before* the order-existence check, so payloads for an order that did not exist
yet are in R2 even though the ledger never saw them and no `order_events` row references them.
And it is **uninterpreted** — `order_events` records the ledger's verdict, while R2 holds the
payload that verdict was formed from, including fields from a future schema version this build
does not understand.

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
| **Deterministic ordering** | State machine + pending buffer + eviction | Arrival order deciding the outcome. The ledger converges on causal order regardless of the sequence events arrive in — and the buffer only ever holds events with a future. |
| **Monotonic projection guard** | `WHERE projection_version < ?` | A late projection write rewinding the read model, so a merchant watches the collected total go backwards. |
| **Schema versioning** | `schema_version`, additive-only; raw bytes preserved in R2 | A new optional field from the courier breaking ingestion, or being silently discarded on the way to the audit log. |

---

## Compute choices

**Everything is serverless**, and Workers are the Lambda-family model: no server to
provision, no capacity to plan, per-request billing, and cold-start behaviour that is a
platform concern rather than ours. For a system whose load is "whatever the courier sends,
whenever they send it", paying only for invocations is the right shape — the alternative is a
box sitting idle overnight waiting for a webhook.

**The consumer is IO-bound, not CPU-bound.** Its work is an R2 write, a D1 read, a DO call, a
D1 write — waiting on the network four times and computing almost nothing in between. That is
why a 10 ms CPU limit per invocation is not a constraint here, and why the tuning knob that
matters is concurrency rather than compute.

**Durable Objects exist in this design to escape the statelessness serverless forces on you.**
Stateless compute is the right default and it is genuinely limiting for exactly one thing here:
a ledger needs a single, authoritative, serialised place for its state. The usual answer is to
push that state into a database and then reintroduce coordination on top of it (see [why not
just D1](#why-a-durable-object-for-the-ledger--and-why-not-just-d1)). Durable Objects are the
platform admitting that some state wants an *address* rather than a table, and giving it one —
stateful compute, single-threaded per key, everything else still serverless.

---

## What I deliberately didn't use

- **Cloudflare Workflows.** Durable execution, retries, and multi-step orchestration —
  genuinely the right tool for a long-running saga with steps that must resume after failure.
  This pipeline is not that: each event is a single short unit of work whose durability need is
  already met by the queue's retry and the ledger's idempotency. Adding Workflows would add a
  runtime and a mental model to buy something already covered.
- **KV for the ledger.** Eventually consistent by design. Correct for a like counter, wrong
  for the field recording how much cash a courier is holding.
- **Synchronous webhook processing.** Rejected for the reason in [Why a
  Queue](#why-a-queue): it converts our latency into their timeout, and their timeout into our
  duplicates.
- **A real courier API.** No Pathao or Aramex access. The simulator sends real HTTP to the
  real webhook, so the *ingestion path* is real end to end; what is simulated is who is calling
  it. Said plainly rather than implied away.
- **An external Postgres via Hyperdrive.** Would reintroduce connection pooling, a second
  operational surface, and the same concurrency problem the Durable Object already solves
  structurally.
- **WebSockets or SSE for the dashboard.** Polling every two seconds is *worse* technology and
  the better choice here: it makes replication lag visible, which is the thing the demo is
  about. A live-pushed dashboard would hide the exact property being demonstrated.

---

## Schema evolution, and the EDI parallel

The courier event carries a `schema_version`, and evolution is **additive-only**. Adding a new
optional field is safe: the validator ignores what it does not recognise, and — because the
webhook writes the **verbatim request bytes** to R2 rather than re-serialising its parsed
view — a field this build has never heard of still survives into the audit log intact. Removing
or renaming a field is a breaking change and needs a version bump with both versions supported
during the transition.

This is a small instance of the problem structured document exchange has dealt with for
decades. EDIFACT and ANSI X12 exist because two organisations who do not share a codebase, a
release cycle, or a deployment window nonetheless have to agree on the shape of a message —
and the agreement has to survive one side upgrading first. Their answer is a versioned,
strictly-specified document with defined extension points, so that a partner sending a newer
revision does not break a partner reading an older one.

The parallel is real and it is narrow: a versioned event contract between a platform and its
logistics partner is the same *problem*, at a fraction of the scale and with none of the
formal machinery. It is worth naming because it explains why "just add the field, everyone will
redeploy" is not available — the courier is not ours to redeploy.

---

## API surface

Every read names the zone that answered it, in a `source` / `consistency` pair on the
response body. A caller should never have to guess whether it is holding truth or a copy.

| Method | Path | Zone | Notes |
|---|---|---|---|
| `POST` | `/api/orders` | D1 write | Creates the order registry row. `201` + `order_id`. |
| `GET` | `/api/orders` | D1 read (AP) | Dashboard list. `?merchant_id=`, `?limit=`. |
| `GET` | `/api/orders/:id` | D1 read (AP) | Order, event timeline, and any orphaned events that named this `order_id` before it existed. |
| `GET` | `/api/orders/:id?authoritative=true` | **DO read (CP)** | The above *plus* the ledger read directly, and a `divergence` block comparing the two. |
| `GET` | `/api/orders/:id/audit` | R2 list | Raw payload references. `?event_id=` returns the stored bytes verbatim. |
| `GET` | `/api/dead-letters` | D1 read (AP) | Messages that failed every retry and were moved to `courier-events-dlq`. |
| `POST` | `/webhook/courier` | Queue producer | Bearer auth, validate, enqueue, `202`. Never touches D1 or the DO. |

### `?authoritative=true` — the teaching feature

The dashboard normally reads the D1 projection, because a list of 200 orders cannot make 200
Durable Object round trips. This toggle reads the ledger *as well*, and returns the two side
by side with a comparison:

```jsonc
"divergence": {
  "projected_version": 2,        // where the read model is
  "authoritative_version": 2,    // where the ledger is
  "versions_behind": 0,          // the honest measure of lag
  "diverged_fields": [],
  "converged": true
}
```

`versions_behind` is the honest way to describe a lagging read model: it is not *wrong*, it
is a specific number of applied events behind, and that number returns to zero on its own.
Refresh during a burst and watch it rise and fall.

The genuinely alarming reading would be a non-empty `diverged_fields` at
`versions_behind: 0` — same version, different answer, meaning a projection write went
*astray* rather than late. The convergence test asserts against exactly that.

It is opt-in because it costs a DO round trip. The list view never pays it; a single order
being inspected does.

### Why the audit endpoint is not just the timeline again

R2 holds the verbatim bytes of every payload, written *before* anything is decided about it.
That makes it wider and flatter than the D1 timeline in two ways that matter:

- **Wider.** The audit write happens before the order-existence check, so an order created
  *after* its events arrived has payloads in R2 that the ledger never saw.
- **Uninterpreted.** The timeline shows the ledger's verdict; the audit log shows the payload
  the verdict was formed from — including fields a future schema version added that this
  build does not yet understand.

Different data, different shape: a listing of opaque blobs addressed by key is what an object
store is for, and what a relational read model is bad at.

---

## Free-tier limits

Every primitive in this system runs on the Cloudflare **free** plan. Naming the constraints
is part of understanding the design, so here they are — with the headroom this demo actually
needs.

Every figure below is **re-verified against the live Cloudflare pricing page on 2026-08-22**.
No estimates, no remembered numbers — these move (Queues only joined the free plan on
2026-02-04, and Durable Object storage billing began 2026-01-07).

| Primitive | Free-plan limit | What this system spends |
|---|---|---|
| **Workers** | 100,000 requests/day; 10 ms CPU per invocation | The webhook validates and enqueues — microseconds of CPU. Dashboard polling is the volume driver. The ledger's per-event rewrite is the only work that grows with an order's history; [the headroom against the 10 ms ceiling is worked through here](#honest-limitations). |
| **Durable Objects — requests** | **100,000 requests/day** | One per courier event, plus one per authoritative dashboard read. This is the ceiling that actually binds — see the note below the table. |
| **Durable Objects — duration** | **13,000 GB-s/day** | The ledger does microseconds of work per event. Never the constraint. |
| **Durable Objects — SQLite storage** | **5 GB total**, plus rows billed at D1 rates: 5,000,000 rows read/day, 100,000 rows written/day. Storage billing began **2026-01-07** | Each `put()` counts as a row write. The ledger writes `state`, `processed`, `history` and `pending` per applied event — roughly four row writes each. See [Honest limitations](#honest-limitations): those keys are rewritten in full every time, which is the real cost here, not the 5 GB. |
| **Queues** | 10,000 operations/day (reads + writes + deletes combined); all features incl. DLQ, retries, batching | ~3 ops per courier event (write, read, delete) → ~3,300 events/day. The tightest ceiling on ingestion specifically. A **poison** event costs far more: 6 delivery attempts plus the DLQ write and its own read, so roughly 9–10 operations before it is finally set aside. |
| **Queues — retention** | **24 hours**, non-configurable (paid: 14 days) | Irrelevant at demo scale; events are consumed in seconds. In production it means a consumer outage longer than a day loses buffered events outright. |
| **D1** | 5 GB total storage; 5,000,000 rows read/day; 100,000 rows written/day | Two row writes per event (the projection, guarded; the timeline row). Dashboard reads are a single indexed scan of `orders`. |
| **R2** | 10 GB-month storage; 1,000,000 Class A ops/month (writes); 10,000,000 Class B ops/month (reads); **free egress** | One small JSON write per event received. The audit log is the cheapest part of the system. |
| **Pages** | Unlimited requests and bandwidth; 500 builds/month; 1 concurrent build | Static frontend. Never a constraint. |

**Why the 100k/day request ceiling is the binding constraint.** Each **RPC method
call on a Durable Object stub is billed as one request**. Every courier event is therefore
one DO request, and every "authoritative (CP)" toggle on the dashboard is another — all
drawn from the *same* 100,000/day pool the Worker itself spends from. The constraint on this
system is not storage and not bandwidth; it is that shared request ceiling, and a polling
dashboard is what burns through it. **Poll interval is a real design parameter here, not a
cosmetic one** — a 1-second poll across 20 open dashboards is 1.7M requests/day and blows
the free plan on its own, while the ledger it is watching would still be comfortably inside
every other limit.

These figures do move — Queues itself only joined the free plan on 2026-02-04 (decision log
§6), and DO storage billing only began 2026-01-07.

---

## Running it

Two terminals. The console is served on a **different origin** from the API on purpose — see
Decision 14.

```bash
npm install
npm run db:migrate:local     # apply 0001 + 0002 to the local emulated D1

# terminal 1 — the Worker: API, webhook, queue consumer, DLQ consumer, ledger
npm run dev                  # http://127.0.0.1:8788

# terminal 2 — the console
npm run frontend             # http://127.0.0.1:8789
```

Open **http://127.0.0.1:8789**. The whole pipeline runs locally: `wrangler dev` emulates D1,
R2, Queues and Durable Objects together, so events really do traverse the queue and really are
consumed asynchronously.

### Driving the simulator

1. **Create an order** in the form on the left. Note the `order_id` it returns.
2. **Open it** from the dashboard. The simulator panel is at the top of the detail view.
3. Press a scenario. Each button makes real authenticated POSTs to `/webhook/courier`:

| Button | What to watch |
|---|---|
| **Happy path** | Dispatched → paid in full → delivered. Settles to `FULLY_COLLECTED`. |
| **Send payment twice** | The same `event_id`, twice. **Collected must not double.** The timeline row reads `applied · ×2`. |
| **Returned before dispatch** | `returned` lands first and shows as `buffered` for five seconds — money untouched — then `delivery_attempted` arrives and the buffer drains. Both apply, in causal order. |
| **Partial payment** | 40% collected. `PARTIALLY_COLLECTED`, and the bar stops short of the expected line. |
| **Custom event** | Any type, amount and `occurred_at`. Useful for building a discrepancy by hand. |
| **Send a poison event** | Fails every retry. ~35 seconds later it appears in the dead-letter panel on the dashboard. |

Tick **Compare with the ledger** on the detail view to read the Durable Object directly
alongside the projection, with `versions_behind` between them. Fire a scenario with it on and
watch the number rise and return to zero.

### Verifying it rather than trusting it

```bash
npm run check              # ladder totality proof + typecheck. No server needed.

# these need `npm run dev` running
npm run verify:convergence # 72 assertions: duplicates, disorder, buffer eviction, projection
npm run verify:cors        # 33 assertions: CORS logic (a harness, NOT a browser)
npm run verify:dlq         # fires a poison event, watches for the dead-letter hand-off
npm run assert:no-phantom  # an unknown order_id must spawn no ledger
```

### Deploying

No Cloudflare account has been used, so everything below is written from the docs and is
**unverified** — see [Deferred to deploy](#deferred-to-deploy-not-yet-verified-against-real-resources).

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

**The courier is simulated.** No Pathao or Aramex access. The simulator makes real HTTP calls
to the real webhook, so the ingestion path is genuine end to end — but the caller is a browser
panel, not a logistics company. The reconciliation engine is the real part, and it is the part
worth grading.

**Durable Object storage grows without bound, and the growth is worse than linear.** This is
the most substantial limitation in the system, so precisely: the ledger keeps `processed`
(every `event_id` it has ever seen), `history` (every applied event), and `pending`, and
`applyEvent` **reads all of them and writes all of them on every event**. For an order with
`n` events that is O(n) storage and O(n) work *per event*, so O(n²) over the order's life.

**This does not collide with the 10 ms CPU ceiling, and the margin is worth stating rather
than assuming.** The two facts share a page and look like they might fight: a per-event
rewrite that grows with `n`, against a hard per-invocation CPU limit. They do not, because `n`
here is *small and bounded by the domain*. A COD order's entire lifecycle is five to ten
events — dispatched, one or two payments, delivered or returned — so `processed` and `history`
together are a couple of kilobytes, and serialising that is microseconds: three orders of
magnitude inside the budget. It also helps that **the 10 ms is CPU time specifically**; the
storage round trips are I/O and do not count against it, so the only thing the ceiling
measures here is the serialise/deserialise work itself.

Where it *would* start to matter: at a few hundred bytes per entry, a single order would need
to accumulate events into the **low thousands** before the per-event rewrite became a
hundreds-of-kilobytes JSON round trip and a real fraction of 10 ms. Hundreds of events on one
order is still comfortable; thousands is the boundary. An order receiving a thousand courier
reports has stopped being a reconciliation problem and become something else — which is why
this is a documented boundary rather than a bug. It is still a boundary, and a hot key of a
different shape (a per-merchant or per-courier ledger, say, rather than per-order) would find
it quickly.

At demo scale it is invisible — an order sees maybe six events, and the whole record is a few
kilobytes. It would become real for a long-lived or high-volume key. The fixes are known and
deliberately not built: keep `history` in the DO's SQLite tables rather than a single
serialised key so appends do not rewrite the whole array; expire `processed` entries past the
queue's 24-hour retention window, after which a redelivery is impossible anyway; and archive
settled orders out of the DO entirely, since a terminal order's ledger is never written again.

**The merchant API is unauthenticated.** `POST /api/orders` and every read are open. The
courier webhook has a bearer token; the merchant surface has nothing, because there is no
identity model. A real deployment needs auth and per-merchant authorisation before it is
anything but a demo.

**The simulator holds the courier secret in the browser.** A shared secret in client-side
JavaScript is not a secret. Acceptable only because the panel stands in for the courier's own
server and is a development tool; it must never be deployed with a live credential.

**No pagination.** The dashboard reads up to 100 orders and the detail view reads a whole
timeline. Fine at demo scale, wrong at any real volume.

**The reconciliation ladder is a snapshot, not a workflow.** It says an order is a
`DISCREPANCY`; it has no notion of someone acknowledging one, chasing it, or resolving it.
That is the next feature and it is not built.

**Everything is verified against local emulation only.** No resource has ever been created on a
real Cloudflare account. The next section lists exactly which claims that leaves unsettled,
rather than letting local success stand in for deployment.

---

## Deferred to deploy (not yet verified against real resources)

Development so far has run entirely on **local emulation** — `wrangler dev` with local D1,
R2, Queues and Durable Objects. Local emulation is faithful enough to prove application
logic, and everything below the line has been proven that way. But it is a simulation of the
platform, not the platform, and a few claims this README makes are precisely the ones it
cannot settle. Those are listed here rather than quietly assumed, so nothing skips
verification when a Cloudflare account exists.

**Claims local emulation cannot prove — do not present these as working until checked:**

| # | Claim | Why local can't settle it | How to verify once deployed |
|---|---|---|---|
| 1 | **Dead-letter hand-off in PRODUCTION** — poison messages land in `courier-events-dlq` instead of blocking the pipeline | The hand-off **is** now demonstrated in local emulation: `npm run verify:dlq` fires a poison event, the log shows 6 attempts (initial + `max_retries: 5`), and ~36 s later the DLQ consumer records it in `dead_letters`. That is real evidence and it is **emulator** evidence — the local queue is not the production scheduler, and its hand-off is its own implementation of the behaviour, not the behaviour | Run the same poison event against a real queue; confirm the message appears in `courier-events-dlq` and that the DLQ consumer fires |
| 2 | **Retry backoff timing** — real spacing between attempts | Locally the 5 retries complete in ~36 s. Production backoff is scheduled by Cloudflare and will not match | Induce a transient failure; observe the real retry spacing and eventual success |
| 3 | **`d1 migrations apply --remote`** | Both migrations only ever applied to a local emulated D1 | Run against the real database; confirm all four tables and every CHECK constraint materialise, and that `0002` applies on top of `0001` cleanly |
| 4 | **Resource creation** — `d1 create`, `r2 bucket create`, `queues create` ×2 | No account; `database_id` in `wrangler.jsonc` is still a placeholder | Create all four, paste the real `database_id`, redeploy |
| 5 | **Production secret** — `COURIER_SHARED_SECRET` via `wrangler secret put` | Only `.dev.vars` has been exercised | `wrangler secret put`, then confirm the webhook still 401s on a wrong bearer |
| 6 | **Batching and consumer concurrency** under real load | Local batching does not reproduce production scheduling or backpressure | Fire a burst; observe `max_batch_size` / concurrency behaviour |
| 7 | **Free-tier limits in practice** | Nothing has been metered against a real account | Watch the dashboard's usage panel during a demo run |
| 8 | **Pages itself** — the console is served locally by `scripts/serve-frontend.mjs`, not by Pages | A plain static server exercises none of Pages' own behaviour. Named precisely, three things go unexercised: **(a) binding access from the frontend layer** — Pages Functions reading `env` (D1, R2, a DO); **(b) Pages routing** — `_redirects`, `_headers`, SPA fallback, trailing-slash normalisation, its 404 handling; **(c) Pages' response headers** — its own caching and compression, where the dev server sends a blanket `no-store`. **How big is this gap today? Small, and deliberately so: the console is purely static over HTTP — three files, no `functions/` directory, no binding, no `_redirects`, no `_headers`, and hash-based routing that never asks the server to resolve a path.** Every request it makes goes to the Worker on the other origin. So (a) is not merely untested, it is unused — and that is the whole reason a static stand-in is honest here rather than a shortcut | Deploy the Pages project; confirm the three files serve and the hash routes resolve. **The deploy-day risk to watch: if the console ever grows a `functions/` directory or expects ANY binding, this row stops being small and that code will never have run before it runs in production.** Then add the real `*.pages.dev` origin to `ALLOWED_ORIGINS` and re-run `npm run verify:cors` against the deployed pair |
| 9 | **Browser-confirmed CORS** — an actual browser, under an actual same-origin policy, handing response bodies to the page | `npm run verify:cors` proves the CORS *logic*: it sends browser-shaped headers and asserts the response headers are right. It is not a browser and enforces no same-origin policy, so it cannot prove the browser accepts what it validated (Decision 12) | Open the console, watch the network panel: every API call 200 with `Access-Control-Allow-Origin`, no CORS errors in the console, and the dashboard populated with real rows |
| 10 | **The projection race the version guard exists for** — two consumer invocations writing one order's state concurrently, the older one losing | Local queue batches drain sequentially in a single isolate, so **the race never happens here at all.** The guard is present and proven *correct*; its *necessity* is reasoned from the execution model, not observed | Force genuine two-consumer concurrency on ONE order post-deploy (burst + consumer concurrency > 1) and confirm the guard drops the loser: `projection_version` never decreases, and every `projection=stale` log line corresponds to state already superseded rather than state lost |

### `0001_init.sql` is FROZEN as of Phase 4 — not "when we deploy", now

Migration `0001` was edited in place three times: `discrepancy_reason` and `orphan_events`
(Decision 3, 5), then the `'received'` outcome, then `delivery_count` and the three-verdict
`outcome` vocabulary (Decision 9). Each was legal under the original rule, which froze the
file the instant `wrangler d1 migrations apply cod-recon --remote` first succeeded.

That rule was correct and it was still the wrong rule, because it reads as a licence. Its
only enforcement is an event that has not happened yet, so in practice it permitted an
unbounded number of rewrites and quietly invited "one more, while we still can." **It was a
countdown, not a licence, and three rewrites is where the countdown ends.**

**Declared here, unconditionally and with no Cloudflare account in existence: `0001` is
frozen. The next schema change of any size is `0002_*.sql`.**

The reasoning is that a `0002` written against a local database costs *exactly* what editing
`0001` costs — same effort, same rebuild, same seconds — and it is the only version of the
habit that survives contact with a real deployment. Deferring the discipline to the moment it
becomes expensive means learning it at the worst possible time. So it starts now, while it is
free.

**Is the schema settled?** Yes, and specifically:

- `orders` carries the full six-value ladder, `discrepancy_reason`, and the CHECK invariant
  binding the two together. The projection writes every column and nothing is missing.
- `order_events` carries the ledger's three verdicts and `delivery_count`. Decision 9 was the
  cleanup that removed the dead values; there is nothing left to remove.
- `orphan_events` is terminal by design and has no further states to represent.
- Phase 5 (frontend) is **read-only** — no schema surface at all.

**The one change I can foresee, named in advance so it does not arrive as a surprise edit:**
Phase 6 wires the dead-letter queue. If poison events get *recorded* rather than only
observed, that is a dead-letter landing table. It is a new table, which is a textbook `0002`,
and it will be written as one.

**Why this matters more than it sounds.** A remote D1 records `0001` as applied in
`d1_migrations`. Editing the file afterwards does not re-run it — the file and the live schema
diverge silently, and every later migration is built on a schema that does not exist. SQLite
sharpens this: it cannot `ALTER` a `CHECK` constraint, so something as small as adding a
seventh `reconciliation_status` needs a full table rebuild — create-new, copy, drop-old,
rename — written as its own migration. Nothing about that gets easier by postponing it.

**The honest status of the DLQ, specifically.** This one moved, and it is worth being precise
about how far.

Previously it was a pure *wiring* claim: configured in `wrangler.jsonc`, with a consumer
failure path written to trigger it, and nothing more. It is now more than that. `npm run
verify:dlq` sends a well-formed event carrying the reserved `sim-poison` courier id, the
consumer throws on every attempt, the dev log shows **six** `[retry]` lines for that event
(the initial attempt plus `max_retries: 5`), and roughly 36 seconds later a
`[dead-letter]` line records it in the `dead_letters` table. The full path — exhaustion,
hand-off, second consumer, D1 row — executes.

**And it executes in an emulator.** `wrangler dev` implements queue semantics locally; it is
not the production scheduler, and a hand-off that works in its implementation is evidence
about its implementation. The retry *timing* in particular is certain to differ. So: the DLQ
is **demonstrable**, and it is **not yet proven in production**. Both halves of that sentence
matter, and the second one keeps it on this list.

---

## Decision log

Appended at each phase checkpoint, while the reasoning was fresh. Each entry states the
open question, the decision, and the consequence. Where a decision amends the original
build spec, the amendment is called out explicitly.

### 1. Money is whole NPR integers, everywhere

**Question.** The spec's event contract said "minor units or NPR" — an ambiguity that would
have become a 100× bug the first time one side guessed differently.

**Decision.** Whole NPR integers, no subunit, no floats. A single exported constant
(`CURRENCY` in `src/shared/constants.ts`) carries the code, symbol, `minorUnits: 0`, and a
human label, and is imported by the validator, the Durable Object, and the frontend. One
predicate, `isValidAmount()`, is the only amount check in the codebase:
`Number.isInteger(value) && value > 0`.

**Consequence.** The webhook returns `400` for `payment_collected` and `partial_payment`
when the amount is a float, a string, zero, or negative. For the three non-payment event
types an `amount` field, if present, is **ignored rather than rejected** — a courier
attaching a harmless extra field should not fail the delivery of a lifecycle event. That
asymmetry is deliberate: strict where money is at stake, forgiving where it is not.

Integers also make the ledger exactly comparable. `collected == cod_amount` is a safe test
in a way it would never be with floats — which matters enormously, because the entire
reconciliation ladder below turns on exact equality.

### 2. Five event types, one array, derived union

**Question.** Spec §1 listed four event types in prose; the state machine in §6 used five.

**Decision.** Five is correct — `delivery_confirmed` is the transition into `DELIVERED` and
cannot be dropped. **Spec amendment: §1's four event types are corrected to five.**

`EVENT_TYPES` is one `as const` array and the TypeScript union is *derived* from it
(`typeof EVENT_TYPES[number]`), never written twice. The validator, the DO state machine,
the simulator, and the D1 `CHECK` constraint all trace back to that array. Adding a sixth
event type is a one-line change plus the compiler telling you every switch that no longer
covers its cases.

`payment_collected` and `partial_payment` share **one accrual code path**
(`PAYMENT_EVENT_TYPES`, `isPaymentEvent()`). They are not different algorithms — a "partial"
payment is only a courier's label for the same `amount_collected += amount`. Keeping them on
one path means the idempotency guarantee is proved once, not twice.

### 3. Reconciliation is a six-value total ladder

**Question.** The spec's five reconciliation outcomes had overlapping conditions and, worse,
a gap: an order that was fully paid but not yet delivery-confirmed matched *nothing*. It
would have landed on `null`.

**Decision.** A sixth value, **`AWAITING_CONFIRMATION`**, plus a strict first-match-wins
ladder that is **total** — every combination of lifecycle status and money resolves to
exactly one value, always:

| # | Value | Condition |
|---|---|---|
| 1 | `DISCREPANCY` 🚩 | `RETURNED && collected > 0`, or `DELIVERED && collected < cod_amount`, or `collected > cod_amount` (any state) |
| 2 | `FULLY_COLLECTED` | `DELIVERED && collected == cod_amount` |
| 3 | `RETURNED_UNPAID` | `RETURNED && collected == 0` |
| 4 | `AWAITING_CONFIRMATION` | non-terminal && `collected == cod_amount` |
| 5 | `PARTIALLY_COLLECTED` | `0 < collected < cod_amount` |
| 6 | `PENDING` | `collected == 0` (total catch-all) |

`AWAITING_CONFIRMATION` is a **benign in-progress state, not a red flag.** The money is
right; only the paperwork is outstanding. `DISCREPANCY` is the sole flagged value — a
dashboard that flags healthy orders trains merchants to ignore it.

**Closing the ladder's one hole.** The locked spec put `DISPATCHED` in rung 4's guard. That
left `PENDING && collected == cod_amount` matching no rung and falling through to `null` —
the exact failure the totality requirement exists to prevent. Rung 4 is therefore guarded on
*both* non-terminal statuses (`DISPATCHED || PENDING`) rather than `DISPATCHED` alone. The
combination is unreachable through the state machine — money only accrues after dispatch —
but a ladder that depends on the state machine never having a bug is not total, it is
merely lucky. The widening is the minimum that closes the hole and changes no reachable case.

**Proof, not assertion.** `npm run verify:ladder` enumerates all four statuses × seven money
relations (including every boundary: 0, 1, cod−1, cod, cod+1, 2×cod) and asserts that all 28
cells resolve, that `discrepancy_reason` is non-null *exactly* when the status is
`DISCREPANCY`, and that all six values are reachable — no dead rungs. It exits non-zero
otherwise. Totality is a test, not a claim in a comment.

**`discrepancy_reason`.** A flag that does not tell a merchant which call to make is a flag
they learn to ignore. `DISCREPANCY` therefore always carries one of
`RETURNED_WITH_PAYMENT` / `DELIVERED_UNDERPAID` / `OVERPAID`, on both the DO state and the
D1 row. Where two reasons could apply — a returned order that also overpaid — the reason
resolves first-match-wins in the same order the conditions are listed, so
`RETURNED_WITH_PAYMENT` wins: recovering cash sitting with a courier is the more urgent
call than a refund. **Spec amendment: §7.2 `orders` gains a `discrepancy_reason` column.**

### 4. Overpayment is a discrepancy, and the ledger never clamps

**Question.** What happens when a courier reports more money than the order was worth?

**Decision.** `DISCREPANCY`, reason `OVERPAID`. The ledger accrues the true amount with **no
clamping** — it records what happened; the ladder interprets it. A ledger that silently
caps `amount_collected` at `cod_amount` is a ledger that lies, and the evidence you need to
recover the money is exactly the evidence it destroyed.

**Spec amendment: §6's `FULLY_COLLECTED` changes from `collected >= cod_amount` to
`collected == cod_amount`.** Under `>=`, an overpayment would have been reported as a
perfectly settled order — the loudest possible failure hidden behind the calmest label.

**Why this is the interesting case.** Overpayment is the one money bug **idempotency cannot
catch.** Two `payment_collected` events with *distinct* `event_id`s are, as far as dedup can
tell, two genuine payments; they sail straight through the `processed_ids` check and accrue
twice. Dedup answers "have I seen this event before?" — it cannot answer "should this event
have existed?" Only reconciliation against the expected amount can. That is precisely why
overpayment is flagged here rather than defended against upstream: the two mechanisms cover
different failures, and the system needs both.

### 5. Unknown `order_id` → orphan path, never a phantom ledger

**Question.** An event arrives for an `order_id` that does not exist. Throw and retry?
Dead-letter it? Create the order?

**Decision.** None of those. The consumer writes the raw payload to R2 **first** (always —
the audit log records everything received, valid or not), records the event in a new
`orphan_events` table, and **acks**. It does not throw, does not dead-letter, and above all
**does not call the Durable Object.**

**Why the DO must not be touched.** Durable Objects are addressed *by name*. Calling
`ORDER_LEDGER.idFromName("ord_typo")` does not fail — it cheerfully creates a brand-new
ledger. A single malformed `order_id` would spawn a phantom ledger accruing real money
against an order no merchant can see. The existence check is not validation hygiene; it is
the thing standing between a typo and untracked cash.

**Why not retry or DLQ.** Retrying assumes the condition is transient. It is not: an order
that does not exist now will not exist in thirty seconds either, so five retries and a
dead-letter is five wasted attempts ending in the same place, having burned queue budget and
delayed every event behind it. Orphans are **terminal** — never reprocessed, but fully
queryable as an unmatched-events view. The DLQ stays reserved for genuinely poisonous
messages, which keeps it meaningful: anything in the DLQ is a real bug, not a mistyped
order id.

**Why a separate table.** `order_events.order_id` carries a foreign key to `orders`, and
that FK is a large part of what makes a phantom impossible — it is verified enforced in D1,
not merely declared. Orphans, by definition, violate it. The choice was to weaken the FK for
every row or to route the exceptions around it; weakening a constraint to accommodate the
one case it was written to catch is backwards. **Spec amendment: §7.2 gains an
`orphan_events` table.**

**One read, two jobs.** The existence check reads the order from D1 anyway, so it returns
`cod_amount` in the same query — the value the DO needs to reconcile. The safety check and
the data fetch are a single round trip, so correctness here costs nothing.

### 6. Verified: the "all free tier" claim holds, Queue included

**Question.** Queues was historically a Workers **Paid**-only product, which would have
broken the spec's premise that the whole stack runs on the free tier and forced the
ingestion layer onto a Durable Object alarm buffer instead.

**Verified against current Cloudflare documentation:** Queues joined the Workers **free**
plan on **2026-02-04**, with all features included — dead-letter queues, retries, batching,
consumer concurrency. `wrangler queues create` works on a free account. The spec's stack
table stands as written and **the Queue stays**.

This mattered enough to check rather than assume. Swapping to a DO-alarm buffer would have
kept the async-ingestion story but silently dropped the two Day-4 primitives the design
leans on hardest — the DLQ and automatic retry with backoff — replacing framework
guarantees with hand-rolled ones. Verifying a pricing page was cheaper than rebuilding a
reliability layer.

The one free-plan constraint worth recording is **24-hour maximum queue and DLQ retention**
(paid: 14 days). Irrelevant at demo scale, where events are consumed in seconds, but it is a
real operational limit: on the free plan a consumer outage lasting more than a day loses
buffered events outright. Named in the limits table below rather than designed around.

**Every figure in the limits table is doc-verified**, checked against the live Cloudflare
pricing page (last updated 2026-07-07) rather than recalled — no exceptions, and nothing
here carries a "trust me" number into submission. That pass also established that the Durable
Objects entry needed splitting into its three separately-metered dimensions — requests,
duration, and SQLite storage billed at D1 row rates since 2026-01-07 — which is what
surfaced the per-RPC-call billing rule that makes the shared 100,000 requests/day ceiling,
not storage, the real constraint on this design.

### 7. The webhook answers `401`, and that is a contract

**Question.** Spec §5.1 calls the bearer check a "simple auth gesture" and pins no status
code. Unpinned, it would drift — one handler returning `403`, a later one silently dropping
the event, and a frontend guessing which.

**Decision.** **`401 Unauthorized` with a `WWW-Authenticate: Bearer` header** for both a
missing and a wrong credential, and it is treated as a fixed contract, not an implementation
detail. `401` is the semantically correct answer: the request was not authenticated. `403`
would claim the caller *was* identified and then denied, which is a different and untrue
statement. Silently dropping would be worst of all — a courier that cannot tell rejection
from acceptance retries blindly, and blind retries are how duplicate events get made.

Missing and wrong credentials deliberately return the **same** status and body: telling an
unauthenticated caller which of the two it got is free reconnaissance.

The consequence to hold onto: **the simulator, the test scripts and the frontend all expect
`401`.** A future change to `403` or to a silent drop is a breaking change to that contract,
not a refactor.

**Verified:** requests with no `Authorization` header and with a wrong bearer token both
return `401`; neither reaches the queue.

### 8. Decision 5 is asserted, not assumed

The `orphan_events` row proves the orphan path *ran*. It does not prove the property that
actually protects money: that `idFromName("ord_ghost")` never brought a Durable Object into
existence. A phantom ledger would be **silent** — no error, no log line, just a DO accruing
cash against an order no merchant can see. "True by construction" is exactly the kind of
claim that stops being true during a refactor and tells no one.

`npm run assert:no-phantom` (`scripts/assert-no-phantom-ledger.mjs`) closes that gap. It
snapshots the live Durable Object instances, fires a `payment_collected` for an order that
was never created, waits for the consumer, and then asserts five things: the webhook
accepted it (202), an `orphan_events` row exists carrying its R2 audit key, **no** `orders`
row appeared, **no** `order_events` row appeared, and — the assertion that matters — **no
new Durable Object instance came into existence.** It exits non-zero otherwise.

The instance list comes from the local dev server's inspector
(`/cdn-cgi/local/explorer/api/workers/durable_objects/namespaces/{ns}/objects`), which
enumerates real DO instances rather than inferring them.

### 9. `outcome` is the ledger's verdict, and duplication is a separate column

**Question.** `order_events.outcome` started life with five values —
`received | applied | duplicate | buffered | anomaly`. Phase 4 was the first time the
projection actually wrote every row the dashboard reads, and two of those five turned out to
be unreachable.

`received` was a Phase 2 placeholder, written before the ledger existed to rule on anything.
The moment the consumer started recording real verdicts it became dead. `duplicate` was
subtler and more interesting: **a redelivered event is not a verdict.** The ledger answers a
repeat with the verdict the event earned the *first* time, deliberately — at-least-once means
the consumer may be re-asking about an event whose D1 row it never managed to write, and
stamping that row `duplicate` would lose the only record of what the ledger actually did with
it.

**Decision.** `outcome` is **exactly the ledger's three verdicts** — `applied`, `buffered`,
`anomaly` — and nothing else. Every value in the column is something `OrderLedger` can
return. How many times an event arrived is a different question, so it gets a different
column: `delivery_count`, projected from the DO's own count rather than incremented locally,
which is what keeps the write idempotent under queue retries.

**Consequence.** The duplicate demo gets *better*, not worse. A row reading
`payment_collected · applied · delivered 2×` next to an unchanged `amount_collected` says
precisely what happened: the ledger was asked twice and moved money once. A row reading
`duplicate` would have hidden the verdict behind the accident.

An honest caveat: at this layer a genuine courier duplicate and a queue redelivery are
**indistinguishable**, and `delivery_count` counts both. That is not a defect in the counter,
it is what at-least-once delivery means, and the number is labelled as deliveries rather than
duplicates for that reason.

### 10. The projection is a compare-and-set on a monotonic version

**Question.** Two events for one order are serialised inside the Durable Object. The two
consumer invocations that carry their results into D1 are **not** — different queue batches,
possibly different isolates, no coordination between them. Nothing stops the older state from
being written last, and a merchant watching the collected total go *backwards* is exactly the
failure this whole system exists to prevent.

**Decision.** The DO returns a monotonic `version` with every state, and the projection is a
single guarded statement:

```sql
UPDATE orders SET ... WHERE order_id = ? AND projection_version < ?
```

One statement, so the comparison and the write cannot be split by another writer — a
compare-and-set without needing a transaction. A stale write matches zero rows and
disappears.

**Why that is safe rather than lossy:** the DO recomputes and returns the **entire** state on
every event, never a delta. So the newer state that won the race already contains everything
the dropped write was carrying. That is the property that makes losing the race a non-event,
and it is why `projectToD1` reports `"stale"` rather than throwing — a dropped projection is
a correct outcome, not a transient failure to retry.

The same reasoning fixes the column list. Every column the projection writes is a pure
function of DO state, including `last_event_at`, which is the ledger's `last_occurred_at` —
the courier's clock — and **not** the consumer's wall clock. A consumer-derived column would
sit outside the guard: dropped writes would leave it holding a value nothing could reproduce,
and the row would be half-guarded, which is worse than not guarded at all.

**Ordering within the consumer.** Projection first, then the timeline row. Both writes are
idempotent and either order converges under retry, so the tie is broken on what a crash
between them looks like to a merchant. Projection first leaves a correct total with one event
missing from the timeline. Timeline first leaves a visible `payment_collected — applied`
sitting above a total that does not include it: a system contradicting itself about money.
The recoverable state should be the one that does not look like a bug.

**What is proven and what is not.** The guard is present, and `verify:convergence` proves it
is *correct* — it never drops a write that carried something the read model needed. Its
**necessity is reasoned, not observed**: local queue batches drain sequentially in a single
isolate, so the concurrent-write race the guard exists for **does not occur locally at all.**
Nothing here has ever fired it in anger. That is deferred item 10, and it is the only thing
that would turn the CP story from asserted into demonstrated — force genuine two-consumer
concurrency on one order after deploy, and watch the guard drop the loser.

**Verified:** every scenario in `npm run verify:convergence` ends by asserting
`projection_version == ledger version` and field-by-field equality between the D1 row and the
DO state, reached by polling `?authoritative=true` until it converges — polling rather than
sleeping, because the lag being waited out is the point of the design and its duration is not
something a test gets to assume.

### 11. The pending buffer is exempt from the staleness rule, and is not a graveyard

**Found by writing the Phase 4 test, in the flagship demo path.** Two defects, one root.

The state machine rejects a transition whose `occurred_at` predates the last applied one — it
describes a world the ledger has already moved past. Correct in general, and **wrong for an
event coming out of the pending buffer**, for a reason worth naming precisely: it is **double
jeopardy.**

The staleness rule and the buffer are two answers to *one* question — what does this event's
position in the arrival stream tell us about it? The buffer already answered. **Admitting an
event to the buffer IS the ruling that its arrival order is not evidence against it**: that it
is plausibly early rather than wrong. Re-running the arrival-order test on drain puts the
event on trial a second time for the same charge, and lets the second trial reach the opposite
verdict from the first.

It is circular on top of that. A buffered event is by definition one that was waiting on a
prerequisite; the prerequisite is what just advanced the watermark; so the test asks the
buffered event to postdate the very event it was queued behind.

What the exemption does **not** do is excuse a buffered event from the state machine. The
charge that is spent is arrival order *alone* — the transition table and the terminal-state
check still apply in full on every drain pass, which is exactly how a buffered event that has
become impossible gets caught and evicted rather than quietly applied. The only genuinely new
evidence at drain time is the ledger's **state**, and state is what still gets tested.

This is not a contrived edge. It is the headline demo. Fire `returned` before
`delivery_attempted` and the simulator stamps each event as it fires, so the one sent first
carries the *earlier* timestamp — `returned` buffers, `delivery_attempted` applies and sets
the watermark, and `returned` then fails the staleness test on drain. **Every time.**

Worse, failing that test classified it `anomaly`, and the drain loop only *removed* events it
applied. An event classified as an anomaly during a drain was neither applied nor evicted: it
sat in `pending` forever, re-examined on every future event, and the buffer only ever grew.
The demo would have shown an order stuck at `DISPATCHED` with a `returned` held invisibly and
permanently.

**Decision.** Two changes, both in `OrderLedger`:

1. `classify(event, core, { fromBuffer: true })` **skips the staleness rule.** The rule exists
   to reject a transition describing a world the ledger has moved past; it has no business
   judging one the ledger has been holding all along.
2. The drain loop **evicts** anything classifying as `anomaly` — recording it as the anomaly
   it turned out to be, money-truth untouched — instead of putting it back. The buffer is a
   waiting room, not a graveyard: it only ever holds events with a future. In practice that
   means an event orphaned by the order reaching a terminal state while it waited.

The consumer revises the D1 rows for both outcomes (`buffered → applied` on drain,
`buffered → anomaly` on eviction), each guarded on the old value so a replay can never walk a
verdict backwards.

**Consequence worth stating:** a drained transition can move `last_occurred_at` *backwards*.
That is inert today, because every transition that can be buffered — `delivery_confirmed`,
`returned` — lands the order in a terminal state, where the watermark no longer gates
anything, and `delivery_attempted` is never buffered. If a future non-terminal buffered
transition is ever added, this stops being inert and needs revisiting.

**Verified, and the leak is covered specifically.** Scenario 3 of `npm run verify:convergence`
fires the out-of-order sequence with the timestamps in the awkward order and asserts the
buffered row is revised to `applied`, the buffer ends empty, and the ledger history records
the two events in **causal** order (`delivery_attempted` then `returned`) rather than arrival
order.

Scenario 5 exists solely for the leak, because **the leak is invisible to every other kind of
assertion.** A retained dead event corrupts no money, fails no status check and throws
nothing — it just never leaves `pending`, so work per event stops being constant and starts
growing with the number of dead events an order has accumulated. Scenario 5 buffers two early
events, lets the first drain the order into a terminal state (which makes the second
impossible), and then asserts the impossible one was **evicted** rather than retained: its row
revised to `anomaly`, never applied, and the buffer empty. It then fires two further events
and asserts the buffer is **still** empty and the ledger history **still** unchanged — the
after-the-fact check is the one that actually catches a leak, because a retained event is
perfectly quiet until you look for it twice.

### 12. CORS is the first thing built, not the last

**Question.** The console is a Pages project and the API is a Worker. Those are different
origins, in development and in production. Every call the page makes is therefore
cross-origin, and the browser will discard the response unless the Worker authorises it.

This is the single most common way a dashboard like this ends up silently blank, and the
reason it wastes so much time is that **nothing in the system reports it.** The request
succeeds. The Worker logs a 200. `curl` is perfectly happy, because `curl` does not enforce
CORS — only a browser does. The page sees a rejected promise with no status and no body,
because the browser deliberately withholds the details from JavaScript. So the failure
presents as an empty table with no error anywhere, and the natural instinct is to go looking
in the API, which is working fine.

**Decision.** CORS was built and proven **before a single line of UI**, and the proof is a
committed script rather than a memory of a `curl` that worked once. `npm run verify:cors`
replays every request the console makes, with browser headers, against every endpoint it
touches.

Three details, each with a failure mode that only appears in a browser:

- **Allowlist, never `*`.** `*` would make the API callable from any page on the internet,
  and it is incompatible with credentialed requests, so it also forecloses ever adding a
  session cookie without a rewrite.
- **`Vary: Origin`, always — including on rejections.** The response depends on the request's
  Origin, so any cache in the path must key on it. Without it, a cache can serve origin A's
  `Access-Control-Allow-Origin` to origin B. That fails intermittently, only under a warm
  cache, and is close to impossible to reproduce deliberately.
- **Preflight is answered before routing and before auth.** A preflight is an `OPTIONS`
  request the browser sends on its own, carrying no credentials and no body. Route it and a
  POST-only handler returns 405; authenticate it and it returns 401. Either way the browser
  reports a CORS failure and the real request is never sent at all.

`Authorization` is in the allowed header list already, because the Phase 6 simulator posts to
`/webhook/courier` with the courier bearer token, and any request carrying that header
preflights.

**The negative case is tested too**, which is the half that usually goes missing: an origin
that is not on the allowlist must not be reflected, and a caller with no `Origin` header at
all must not have CORS headers invented for it. An allowlist that accidentally reflects
everything passes every positive test ever written.

**Verified — and precisely what is verified.** `npm run verify:cors` makes 33 assertions across
all six endpoints the console calls, plus the two negative cases. Every one passes.

**What that proves is the CORS logic, and nothing more.** The harness sends browser-*shaped*
headers; it is not a browser, and it enforces no same-origin policy. It can prove that
`Access-Control-Allow-Origin` is present and correct on
`/api/orders/:id?authoritative=true`. It cannot prove that a browser, handed that response,
gives the body to the page. Those are different claims, and collapsing them is exactly how
"the CORS tests pass" becomes a reason not to open dev-tools.

The distinction is not pedantic. Everything this script checks is a *header*, and browsers
refuse cross-origin responses for reasons that are not headers — a redirect that drops the
Origin, mixed content, an opaque service-worker response. **Browser-confirmed CORS is
deferred item 10, and is currently unverified.**

### 13. The frontend fetches its vocabulary instead of copying it

**Question.** `src/shared/constants.ts` is the single source of truth for the currency, the
statuses and the discrepancy explanations, and its stated rule is that nothing may re-declare
them anywhere. The console is static — served by Pages, no build step — so it cannot import a
TypeScript module. The obvious move is to hand-copy `Rs.`, the six reconciliation statuses and
the three discrepancy explanations into `app.js`.

That obvious move quietly breaks the rule the whole codebase is organised around. The copy
would be correct on the day it was written and wrong the first time either side changed, and
nothing would fail — the dashboard would just render a status it had no styling for, or
explain a discrepancy using last month's wording.

**Decision.** `GET /health` returns the vocabulary — currency, order statuses, reconciliation
statuses, which of them are flagged, event types, event outcomes, and the discrepancy
explanation text — and the console fetches it at boot before its first render. **The rule
survives the language boundary by crossing it over HTTP.**

A related, smaller version of the same idea: every API response carries `source` and
`consistency`, and the panels print what they were *given* rather than asserting what the page
believes. The dashboard says "d1 projection · eventual" because the API said so. If a read
ever starts coming from somewhere else, the label changes by itself instead of lying.

### 14. Local dev serves the console from a second origin on purpose

**Question.** `wrangler pages dev` merges the Worker's `wrangler.jsonc` bindings into the
Pages project even when the Pages project has its own config, then refuses to start because
the Pages entry shim does not export the `OrderLedger` Durable Object. `wrangler pages dev
--config` is explicitly rejected, so there is no supported way to separate them.

The tempting fix is to stop having two origins: serve the static files from the Worker with
an assets binding and let everything be same-origin.

**Decision.** No — `npm run frontend` runs a 60-line static file server
(`scripts/serve-frontend.mjs`) on port 8789, keeping the console on a genuinely different
origin from the API on 8788.

The reasoning is that the same-origin shortcut hides the exact class of bug it would be
covering up. Production **is** two origins, so a dashboard that works locally because
everything shares a port and then fails on deploy is worse than one that never worked: the
failure arrives later, in front of an audience, and looks like a deployment problem rather
than a missing header. **Development should be able to fail the way production fails.** The
Pages project and its `wrangler.jsonc` are real and `npm run deploy:frontend` deploys it;
only the local dev server is a stand-in, and it is a stand-in for the one thing Pages does
here, which is serve three static files.

### 15. What the console shows, and why it is shaped like a cash book

The subject is not "a list of orders". It is the question a merchant actually has at the end
of a courier's shift: **which of these has money that does not agree with the delivery?**
Everything on the page is bent toward answering that in one glance.

**The reconciliation bar** is the one thing the page is built around. Collected and expected
sit on a **single shared scale**, so the expected line lands where the courier's obligation
ends — and an overpayment physically **overshoots** it. That is not a decorative flourish; it
is Decision 4 rendered. The ledger never clamps `amount_collected` at `cod_amount`, so the
picture of the ledger does not clamp either. A percentage bar would have had to choose
between capping at 100% (hiding the overpayment) or lying about the scale.

**Colour is never the only signal.** Every state carries a word, and a discrepancy also
carries 🚩 and a sentence naming the call the merchant should make — "recover cash from
courier", not "RETURNED_WITH_PAYMENT". Red and green sitting next to each other in a table is
a colourblindness trap, and the words are what make it safe.

**Two seconds of polling, deliberately visible.** The dashboard re-reads every two seconds and
stamps the time, so the read model catching up is something you watch rather than something
the README claims. The `?authoritative=true` toggle on the detail page is the sharper version:
it reads the ledger directly, alongside the projection, and reports `versions_behind` as a
number.

**The empty and failure states do the most work.** An order with a held event says the ledger
has seen events and applied none of them, rather than the reassuring and wrong "nothing has
happened yet". And the unreachable-API banner names **both** causes — Worker down, or origin
not on the allowlist — because the browser refuses to tell the page which one it was, and
guessing wrong costs an hour.

### 16. The poison path is built in on purpose, and it is a `courier_id`

**Question.** A dead-letter queue that has never received anything is a configuration claim.
Demonstrating it needs a message that fails *repeatably* — and waiting for a real bug to
supply one is not a plan.

**Decision.** A reserved `courier_id`, `sim-poison`, makes the consumer throw on every
attempt. Two details are deliberate:

**It is a `courier_id`, not a special event type or a malformed body.** The message must
survive validation completely intact, because the point is a payload that is **perfectly
well-formed and still unprocessable**. A malformed body is rejected at the webhook with a
`400` and never enters the queue at all, so it could never reach a DLQ — the two failure
modes look similar and live in completely different places.

**The throw happens *after* the R2 audit write.** That preserves the invariant the consumer
was built around: everything received leaves evidence, including the messages designed to
fail. Each of the six attempts rewrites the same R2 key with the same bytes, which is exactly
how write-once and at-least-once coexist.

**Consequence to keep in mind:** `sim-poison` is a live trapdoor in the deployed consumer.
Any event carrying that courier id will fail forever, by design. It is documented here rather
than hidden because a reader who finds it in the code should not have to wonder whether it is
a bug.

### 17. The DLQ gets its own consumer, and the opposite failure posture

**Question.** `dead_letter_queue: courier-events-dlq` in the config routes failures somewhere.
It does not make anything *read* them.

**Decision.** The DLQ has its own consumer, and it writes each dead letter into a
`dead_letters` table in D1.

**Why a consumer at all:** an unread queue is a slow way of losing messages. Queue retention
is 24 hours and non-configurable on the free plan, so a message routed to a DLQ nobody drains
is deleted a day later, and the only trace is a log line that has long since scrolled away. A
D1 row outlives the retention window and can be queried after the incident, which is the
entire point of dead-lettering rather than dropping.

**Why the opposite failure posture:** the main consumer *throws* on failure so the queue
retries — correct, because there is somewhere for the message to go and something for a retry
to accomplish. The dead-letter consumer **acks unconditionally**, even when its own write
fails. There is no third queue to fall through to, so retrying here can only burn the
retention window before the message is dropped anyway. It logs loudly and releases the
message. **This is the end of the line, and the end of the line should not be a loop.**

**Why a separate table** rather than a row in `order_events`: a dead letter is not a verdict.
The ledger never saw it, so it has no outcome, no version, and no effect on money. Putting it
in `order_events` would mean weakening either that table's `outcome` CHECK or its foreign key,
and the same reasoning that gave `orphan_events` its own table applies unchanged — route
around a strong constraint rather than weaken it (Decision 5).

**This is also where the `0001` freeze paid for itself.** The dead-letter table is the exact
change the freeze banner named in advance as the one foreseeable schema addition, and it
arrived as `0002_dead_letters.sql` without a moment's debate about whether to fold it in.
Writing it cost what editing `0001` would have cost. That was the whole argument.

### 18. The simulator sends real HTTP, and holds a secret it should not

**Question.** The demo needs to produce duplicate and out-of-order events on command. The
easy version is a function inside the Worker that injects messages onto the queue.

**Decision.** No injection. Every simulator button makes a real, authenticated,
cross-origin `POST /webhook/courier` from the browser — the same request a courier's server
would make, through validation, through the queue, through the consumer.

The easy version would have quietly invalidated the demo. Injecting messages internally
skips authentication, skips validation, skips the producer, and — most importantly — skips
the property being demonstrated: that this system does not control the order or the
uniqueness of what arrives. A simulator that reaches inside the system it is testing proves
that the *inside* works when handed perfect input, which is not the claim.

Two consequences worth stating plainly:

**The event timestamps are stamped as each event fires**, which is why the out-of-order
scenario carries a genuinely *earlier* `occurred_at` on the event sent *first*. That is not a
contrivance to make the demo work — it is the exact case that used to fail the staleness rule
on drain, and it is now the case the fix is aimed at (Decision 11).

**The panel holds the courier bearer token in the browser, and that is indefensible in
production.** A shared secret in client-side JavaScript is not a secret. It is acceptable here
for one narrow reason: this panel stands in for the courier's own server, and it is a
development tool that is never deployed with a live credential. The UI says so where a reader
will actually see it, rather than only here.

### 19. The detail view is rendered in two pieces

**Question.** The detail view polls every two seconds. The simulator lives on the detail view
and contains a form. Rebuilding the whole subtree on a timer destroys whatever the user was
typing, twice a minute, along with their keyboard focus.

**Decision.** The view is split. The **shell** — header, the compare switch, the simulator —
mounts once per order and is never touched again. The **live region** is replaced on every
poll.

The general rule this is an instance of: **anything holding user input must live on the side
of the line that does not get rebuilt.** It also removed a hack — an earlier version saved and
restored focus on the compare toggle after each re-render, which was treating the symptom of a
structure that was wrong.

---

## Appendix: course-concept coverage

| Day | Concept | Where it is in this system |
|---|---|---|
| **1** | Compute, queue, database, object store | Worker, Queues, D1, R2 — all four, each doing the job it is actually for |
| 1 | Fire-and-forget | The webhook answers `202` and hands off; the courier never waits on our storage |
| 1 | "Different data, different shape" | Opaque payload bytes in R2, relational projection in D1, keyed authoritative state in a DO — [three stores, three shapes](#why-d1-for-reads-and-r2-for-the-audit-log) |
| **2** | Serverless vs server | Workers throughout (the Lambda-family model); nothing provisioned, per-request billing |
| 2 | Stateless vs stateful | Stateless Workers everywhere except the one place state needs an address — [the ledger DO](#compute-choices) |
| 2 | CPU-bound vs IO-bound | The consumer is IO-bound: four network waits, almost no compute. Why the 10 ms CPU cap is not the constraint |
| 2 | Concurrency | Consumer concurrency is the throughput knob *across* orders; within one order the DO serialises regardless |
| **3** | CAP — and its limits | [Three consistency zones](#the-three-consistency-zones), plus why "the app is AP" would be a category error |
| 3 | Banking ledger (CP) | The `OrderLedger` Durable Object — money-truth gets the strong posture |
| 3 | Like counter (AP) | Dashboard reads from the D1 projection; two seconds stale is fine and cheaper |
| 3 | Isolation / lost update | [Why a Durable Object, and why not just D1](#why-a-durable-object-for-the-ledger--and-why-not-just-d1) — the argument in full |
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
src/shared/cors.ts            Allowlist, preflight, Vary: Origin (Decision 12)

migrations/0001_init.sql      D1 schema. FROZEN as of Phase 4 — never edit
migrations/0002_dead_letters.sql  The dead-letter landing table

frontend/wrangler.jsonc       The console's own Pages project config
frontend/public/index.html    Console markup — dashboard, order form, order detail
frontend/public/styles.css    Console styles — the cash-book palette and the recon bar
frontend/public/app.js        Console behaviour — polling, routing, rendering
frontend/public/simulator.js  The courier simulator — real POSTs to the real webhook

scripts/verify-ladder.ts      Ladder totality proof (no server needed)
scripts/verify-convergence.mjs  Duplicates, disorder, buffer eviction, projection convergence
scripts/verify-cors.mjs       Every console request replayed with browser headers
scripts/verify-dlq.mjs        Poison event → dead-letter hand-off
scripts/assert-no-phantom-ledger.mjs  An unknown order_id must spawn no ledger
scripts/serve-frontend.mjs    Static server for the console, on its own origin
```
