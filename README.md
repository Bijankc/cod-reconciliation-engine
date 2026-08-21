# COD Reconciliation Engine

An async trust layer for cash-on-delivery orders in Nepali e-commerce.

A COD order marked `delivered` on one system but `returned` on another. A payment counted
twice because the courier's webhook fired twice. **Reconciliation is the act of arriving at
one true answer.** This system ingests late, out-of-order, duplicated courier events and
converges every order onto a single money-truth.

> **Async AP ingestion → CP ledger → eventually-consistent reads.**

**Build status:** Phase 0 complete (scaffold, bindings, schema). Phases 1–6 pending.

---

## Decision log

Recorded at the Phase 0 checkpoint, while the reasoning was fresh. Each entry states the
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
pricing page (last updated 2026-07-07) rather than recalled — with the single exception of
the Pages row, which that pass did not cover and which is footnoted as such. Nothing here
carries a "trust me" number into submission. That pass also established that the Durable
Objects entry needed splitting into its three separately-metered dimensions — requests,
duration, and SQLite storage billed at D1 row rates since 2026-01-07 — which is what
surfaced the per-RPC-call billing rule that makes the shared 100,000 requests/day ceiling,
not storage, the real constraint on this design.

---

## The three consistency zones

| Zone | Posture | Mechanism |
|---|---|---|
| Ingestion | Async, disorder-tolerant | Queue, at-least-once; idempotency keys + pending buffer converge deterministically |
| Reconciliation ledger | **CP** | One Durable Object per order — single-threaded, so the lost update is structurally impossible |
| Dashboard reads | **AP** | D1 projection; a merchant view two seconds stale is fine |

CAP describes what a *replicated datastore* does during a partition. This ledger is
single-writer, so "the app is AP" would be a category error. Three zones, three deliberate
postures, is the honest framing.

---

## Free-tier limits

Every primitive in this system runs on the Cloudflare **free** plan. Naming the constraints
is part of understanding the design, so here they are — with the headroom this demo actually
needs.

Every figure below is **verified against the live Cloudflare pricing page (last updated
2026-07-07)**. No estimates, no remembered numbers.

| Primitive | Free-plan limit | What this system spends |
|---|---|---|
| **Workers** | 100,000 requests/day; 10 ms CPU per invocation | The webhook validates and enqueues — microseconds of CPU. Dashboard polling is the volume driver. |
| **Durable Objects — requests** | **100,000 requests/day** | One per courier event, plus one per authoritative dashboard read. See the footnote: this is the ceiling that actually binds. |
| **Durable Objects — duration** | **13,000 GB-s/day** | The ledger does microseconds of work per event. Never the constraint. |
| **Durable Objects — SQLite storage** | Billed as **rows read/written at D1 rates**: 5,000,000 rows read/day, 100,000 rows written/day free. Storage billing began **2026-01-07** | Each `put()` counts as a row write. The ledger writes `state`, `processed_ids`, `history` and `pending` per applied event — roughly four row writes each. |
| **Queues** | 10,000 operations/day (reads + writes + deletes combined); all features incl. DLQ, retries, batching | ~3 ops per courier event (write, read, delete) → ~3,300 events/day. The tightest ceiling on ingestion specifically. |
| **Queues — retention** | **24 hours**, non-configurable (paid: 14 days) | Irrelevant at demo scale; events are consumed in seconds. In production it means a consumer outage longer than a day loses buffered events outright. |
| **D1** | 5 GB total storage; 5,000,000 rows read/day; 100,000 rows written/day | One projection row write per event; dashboard reads are a single indexed scan. |
| **R2** | 10 GB-month storage; 1,000,000 Class A ops/month (writes); 10,000,000 Class B ops/month (reads); **free egress** | One small JSON write per event received. The audit log is the cheapest part of the system. |
| **Pages** † | Unlimited requests and bandwidth; 500 builds/month | Static frontend. Never a constraint. |

> **† Every row above except Pages** was confirmed in the 2026-07-07 verification pass.
> Pages was not covered by it and is the one line to re-check before submission.

**Footnote — why the 100k/day request ceiling is the binding constraint.** Each **RPC method
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

## Layout

```
src/shared/constants.ts       Single source of truth: units, enums, derived unions
src/shared/reconciliation.ts  The total ladder (pure function, no I/O)
src/shared/types.ts           CourierEvent, LedgerState
src/durable-objects/          OrderLedger — the CP write model (Phase 3)
src/index.ts                  Worker: API, webhook, queue consumer
migrations/0001_init.sql      D1 schema, all decisions folded in
scripts/verify-ladder.ts      Totality proof for the ladder
```

## Commands

```bash
npm run check              # ladder totality proof + typecheck
npm run verify:ladder      # the 28-cell totality proof, alone
npm run dev                # local Worker with all four bindings
npm run db:migrate:local   # apply migrations to local D1
npm run db:migrate:remote  # apply migrations to remote D1
npm run deploy             # wrangler deploy
```
