/**
 * The convergence proof — the test the spec asks for before any frontend exists.
 *
 * Five scenarios, driven entirely through the PUBLIC surface: orders are created
 * over the merchant API and events are delivered over `POST /webhook/courier`
 * with a real bearer token, exactly as a courier would. Nothing reaches into the
 * queue, the Durable Object or D1 directly, because a test that skips the
 * pipeline cannot prove anything about the pipeline.
 *
 *   1. HAPPY PATH        the baseline: three events, in order, settled.
 *   2. DUPLICATE         the same payment event_id twice. The money must not
 *                        move twice. This is the duplicate-charge case study
 *                        reproduced against our own ledger.
 *   3. OUT OF ORDER      `returned` before `delivery_attempted`, with the
 *                        timestamps in the awkward order the simulator actually
 *                        produces. Buffered, then drained, then converged.
 *   4. DISCREPANCY       returned holding cash — the flag a merchant acts on.
 *   5. BUFFER EVICTION   a held event that becomes impossible must LEAVE the
 *                        buffer, and must stay gone. Guards against a leak
 *                        that no money or status assertion can see.
 *
 * Every scenario ends by asserting the SAME structural property, which is what
 * Phase 4 added and what makes the dashboard trustworthy:
 *
 *     the D1 projection equals the Durable Object's state, and its
 *     projection_version equals the ledger's version.
 *
 * That is the version guard doing its job. It is checked by polling
 * `?authoritative=true` until `divergence.converged` is true — polling, not
 * sleeping, because the lag being waited out is the entire point of the design
 * and its duration is not something a test gets to assume.
 *
 * Run against a local `wrangler dev`:  npm run verify:convergence
 */

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8788";
const SECRET = process.env.COURIER_SHARED_SECRET ?? "dev-courier-secret-change-me";
const TIMEOUT_MS = Number(process.env.CONVERGE_TIMEOUT_MS ?? 30_000);

const failures = [];
let checks = 0;

const RUN = Date.now().toString(36);
let seq = 0;
const eventId = (label) => `evt_${label}_${RUN}_${seq++}`;

function check(label, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    failures.push(label);
  }
}

/** The dev server reloads on file changes; a connection reset is noise. */
async function request(path, init, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(`${BASE}${path}`, init);
    } catch (error) {
      if (i === attempts - 1) throw error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function createOrder(customerName, codAmount) {
  const res = await request("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customer_name: customerName,
      merchant_id: "m1",
      cod_amount: codAmount,
    }),
  });
  if (res.status !== 201) throw new Error(`createOrder -> ${res.status} ${await res.text()}`);
  return (await res.json()).order_id;
}

/** One courier event, over the wire, authenticated. Returns after the 202. */
async function send(event) {
  const res = await request("/webhook/courier", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ schema_version: 1, courier_id: "sim-courier-1", ...event }),
  });
  if (res.status !== 202) throw new Error(`webhook -> ${res.status} ${await res.text()}`);
}

async function detail(orderId) {
  const res = await request(`/api/orders/${orderId}?authoritative=true`);
  if (!res.ok) throw new Error(`detail -> ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Poll until the pipeline has caught up. The queue's batch timeout means an
 * event can take seconds to land; the failure mode of a fixed sleep is a test
 * that is both slow and flaky, so this waits on the condition instead.
 */
async function waitUntil(orderId, predicate, description) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    last = await detail(orderId);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`  FAIL  timed out waiting for ${description}`);
  console.log(`        last order:  ${JSON.stringify(last?.order)}`);
  console.log(`        last ledger: ${JSON.stringify(last?.authoritative?.state)}`);
  console.log(`        buffer:      ${JSON.stringify(last?.authoritative?.pending?.map((p) => p.type))}`);
  failures.push(`timeout: ${description}`);
  return last;
}

/** The event is on the timeline — i.e. the consumer has finished with it. */
const processed = (id) => (body) => body.timeline.some((r) => r.event_id === id);

/** The projection has caught up to the ledger, exactly. */
const converged = (body) => body.divergence?.converged === true;

const row = (body, id) => body.timeline.find((r) => r.event_id === id);

/** The structural claim every scenario ends on. */
function assertProjectionMatchesLedger(body, label) {
  const { order, authoritative, divergence } = body;
  check(`${label}: projection converged with the ledger`, divergence?.converged, true);
  check(`${label}: no field diverged`, divergence?.diverged_fields, []);
  check(
    `${label}: projected status == ledger status`,
    order.current_status,
    authoritative.state.status,
  );
  check(
    `${label}: projected money == ledger money`,
    order.amount_collected,
    authoritative.state.amount_collected,
  );
  check(
    `${label}: projected verdict == ledger verdict`,
    order.reconciliation_status,
    authoritative.state.reconciliation_status,
  );
  check(`${label}: pending buffer is empty`, authoritative.pending.length, 0);
}

const t0 = new Date("2026-08-22T09:00:00Z").getTime();
const at = (minutes) => new Date(t0 + minutes * 60_000).toISOString();

console.log(`Convergence proof against ${BASE}\n`);

// ---------------------------------------------------------------------------
console.log("1. Happy path — dispatched, paid in full, delivered");
// ---------------------------------------------------------------------------
{
  const order = await createOrder("Aakancha Thapa", 1500);
  const paid = eventId("happy_pay");

  await send({
    event_id: eventId("happy_dispatch"),
    order_id: order,
    type: "delivery_attempted",
    occurred_at: at(0),
  });
  await send({
    event_id: paid,
    order_id: order,
    type: "payment_collected",
    amount: 1500,
    occurred_at: at(30),
  });
  await send({
    event_id: eventId("happy_confirm"),
    order_id: order,
    type: "delivery_confirmed",
    occurred_at: at(31),
  });

  const body = await waitUntil(
    order,
    (b) => b.order.current_status === "DELIVERED" && converged(b),
    "the happy path to settle",
  );

  check("happy: status", body.order.current_status, "DELIVERED");
  check("happy: collected", body.order.amount_collected, 1500);
  check("happy: verdict", body.order.reconciliation_status, "FULLY_COLLECTED");
  check("happy: no discrepancy reason", body.order.discrepancy_reason, null);
  check("happy: three events on the timeline", body.timeline.length, 3);
  check("happy: every event applied", [...new Set(body.timeline.map((r) => r.outcome))], [
    "applied",
  ]);
  check("happy: payment delivered once", row(body, paid).delivery_count, 1);
  assertProjectionMatchesLedger(body, "happy");
}

// ---------------------------------------------------------------------------
console.log("\n2. Duplicate — the same payment event_id, delivered twice");
// ---------------------------------------------------------------------------
{
  const order = await createOrder("Bikash Shrestha", 2000);
  const payment = {
    event_id: eventId("dup_pay"),
    order_id: order,
    type: "payment_collected",
    amount: 2000,
    occurred_at: at(30),
  };

  await send({
    event_id: eventId("dup_dispatch"),
    order_id: order,
    type: "delivery_attempted",
    occurred_at: at(0),
  });
  await send(payment);
  await waitUntil(order, processed(payment.event_id), "the first payment to land");

  // The same event again — byte for byte, as a courier retrying a webhook call
  // it never saw a response to would send it.
  await send(payment);
  await send({
    event_id: eventId("dup_confirm"),
    order_id: order,
    type: "delivery_confirmed",
    occurred_at: at(31),
  });

  const body = await waitUntil(
    order,
    (b) =>
      b.order.current_status === "DELIVERED" &&
      converged(b) &&
      row(b, payment.event_id)?.delivery_count === 2,
    "the duplicate to be absorbed",
  );

  // The whole point: 2000 collected, not 4000.
  check("duplicate: collected once, not twice", body.order.amount_collected, 2000);
  check("duplicate: verdict", body.order.reconciliation_status, "FULLY_COLLECTED");
  check("duplicate: not flagged as overpaid", body.order.discrepancy_reason, null);
  check("duplicate: timeline has 3 events, not 4", body.timeline.length, 3);
  check("duplicate: payment row counts 2 deliveries", row(body, payment.event_id).delivery_count, 2);
  check("duplicate: payment verdict stays applied", row(body, payment.event_id).outcome, "applied");
  check("duplicate: ledger reports the duplicate", body.authoritative.duplicates, [
    { event_id: payment.event_id, outcome: "applied", deliveries: 2 },
  ]);
  check("duplicate: ledger applied three events", body.authoritative.history.length, 3);
  assertProjectionMatchesLedger(body, "duplicate");
}

// ---------------------------------------------------------------------------
console.log("\n3. Out of order — `returned` arrives before `delivery_attempted`");
// ---------------------------------------------------------------------------
{
  const order = await createOrder("Chandra Gurung", 1200);
  const returned = eventId("ooo_returned");
  const dispatch = eventId("ooo_dispatch");

  // The returned event carries the EARLIER timestamp. That is not a contrived
  // edge: the simulator stamps each event as it fires, so the one sent first is
  // the one stamped first, and a staleness watermark would reject it on drain if
  // buffered events were subject to the watermark. They are not — see the
  // fromBuffer exemption in OrderLedger.classify.
  await send({ event_id: returned, order_id: order, type: "returned", occurred_at: at(0) });

  const held = await waitUntil(order, processed(returned), "the early `returned` to be buffered");
  check("out-of-order: held, not applied", row(held, returned)?.outcome, "buffered");
  check("out-of-order: order untouched while held", held.order.current_status, "PENDING");
  check("out-of-order: one event in the buffer", held.authoritative.pending.length, 1);
  check("out-of-order: ledger applied nothing yet", held.authoritative.history.length, 0);

  // The prerequisite finally arrives.
  await send({
    event_id: dispatch,
    order_id: order,
    type: "delivery_attempted",
    occurred_at: at(5),
  });

  const body = await waitUntil(
    order,
    (b) => b.order.current_status === "RETURNED" && converged(b),
    "the buffer to drain and converge",
  );

  check("out-of-order: converged to RETURNED", body.order.current_status, "RETURNED");
  check("out-of-order: no money moved", body.order.amount_collected, 0);
  check("out-of-order: verdict", body.order.reconciliation_status, "RETURNED_UNPAID");
  check("out-of-order: buffered row revised to applied", row(body, returned).outcome, "applied");
  check("out-of-order: both events applied by the ledger", body.authoritative.history.length, 2);
  check(
    "out-of-order: applied in causal order, not arrival order",
    body.authoritative.history.map((h) => h.event_id),
    [dispatch, returned],
  );
  assertProjectionMatchesLedger(body, "out-of-order");
}

// ---------------------------------------------------------------------------
console.log("\n4. Discrepancy — returned, but the courier is holding cash");
// ---------------------------------------------------------------------------
{
  const order = await createOrder("Deepa Maharjan", 900);

  await send({
    event_id: eventId("disc_dispatch"),
    order_id: order,
    type: "delivery_attempted",
    occurred_at: at(0),
  });
  await send({
    event_id: eventId("disc_partial"),
    order_id: order,
    type: "partial_payment",
    amount: 400,
    occurred_at: at(20),
  });
  await send({
    event_id: eventId("disc_returned"),
    order_id: order,
    type: "returned",
    occurred_at: at(40),
  });

  const body = await waitUntil(
    order,
    (b) => b.order.current_status === "RETURNED" && converged(b),
    "the discrepancy to surface",
  );

  check("discrepancy: status", body.order.current_status, "RETURNED");
  check("discrepancy: cash still out there", body.order.amount_collected, 400);
  check("discrepancy: flagged", body.order.reconciliation_status, "DISCREPANCY");
  check(
    "discrepancy: reason names the action",
    body.order.discrepancy_reason,
    "RETURNED_WITH_PAYMENT",
  );
  assertProjectionMatchesLedger(body, "discrepancy");
}

// ---------------------------------------------------------------------------
console.log("\n5. Buffer eviction — a held event that can never become legal must LEAVE");
// ---------------------------------------------------------------------------
//
// The buffer-leak trap this covers is INVISIBLE to an ordinary functional test.
// A leaked event does not corrupt money, does not fail a status assertion and
// does not throw. It just never leaves `pending`, so every future event for that
// order re-examines it: work per event stops being constant and starts growing
// with the number of dead events the order has accumulated. The only way to see
// it is to assert on the buffer itself, and to keep asserting AFTER the event
// that should have removed it.
//
// The sequence builds a buffered event that becomes impossible while it waits:
//
//   returned            arrives first  -> buffered (order is still PENDING)
//   delivery_confirmed  arrives second -> buffered (order is still PENDING)
//   delivery_attempted  arrives third  -> applies, DISPATCHED, drains the buffer
//                                          `returned` applies -> RETURNED (terminal)
//                                          `delivery_confirmed` is now impossible
//
// A ledger that only removes events it APPLIES leaves `delivery_confirmed` in
// `pending` forever. The assertions below fail loudly if it does.
{
  const order = await createOrder("Eliza Rai", 700);
  const returned = eventId("evict_returned");
  const confirmed = eventId("evict_confirmed");
  const dispatch = eventId("evict_dispatch");

  await send({ event_id: returned, order_id: order, type: "returned", occurred_at: at(10) });
  await send({
    event_id: confirmed,
    order_id: order,
    type: "delivery_confirmed",
    occurred_at: at(11),
  });

  const held = await waitUntil(
    order,
    (b) => processed(returned)(b) && processed(confirmed)(b),
    "both early events to be buffered",
  );
  check("eviction: two events held", held.authoritative.pending.length, 2);
  check("eviction: nothing applied yet", held.authoritative.history.length, 0);

  // The prerequisite lands. `returned` drains and takes the order terminal,
  // which is what makes `delivery_confirmed` impossible.
  await send({
    event_id: dispatch,
    order_id: order,
    type: "delivery_attempted",
    occurred_at: at(12),
  });

  const body = await waitUntil(
    order,
    (b) => b.order.current_status === "RETURNED" && converged(b),
    "the buffer to drain and evict",
  );

  check("eviction: order settled", body.order.current_status, "RETURNED");
  check("eviction: no money moved", body.order.amount_collected, 0);
  check("eviction: buffer is empty", body.authoritative.pending.length, 0);
  check("eviction: only the two legal events applied", body.authoritative.history.length, 2);
  check(
    "eviction: the impossible event was never applied",
    body.authoritative.history.some((h) => h.event_id === confirmed),
    false,
  );
  check("eviction: its row was revised to anomaly", row(body, confirmed).outcome, "anomaly");
  check("eviction: the drained event became applied", row(body, returned).outcome, "applied");

  // THE ASSERTION THAT CATCHES THE LEAK. An evicted event must not reappear in
  // the buffer, and must not be re-examined, on any subsequent event. Fire two
  // more events and confirm the buffer stays empty and the history stays put —
  // a leaked event would still be sitting in `pending` here, quietly making
  // every future event more expensive than the last.
  await send({
    event_id: eventId("evict_after_a"),
    order_id: order,
    type: "payment_collected",
    amount: 700,
    occurred_at: at(20),
  });
  await send({
    event_id: eventId("evict_after_b"),
    order_id: order,
    type: "delivery_confirmed",
    occurred_at: at(21),
  });

  const after = await waitUntil(
    order,
    (b) => b.timeline.length === 5,
    "two more events to be processed against the settled order",
  );

  check("eviction: buffer still empty two events later", after.authoritative.pending.length, 0);
  check("eviction: nothing new was applied", after.authoritative.history.length, 2);
  check("eviction: money still untouched", after.order.amount_collected, 0);
  check(
    "eviction: post-terminal events recorded as anomalies",
    after.timeline.filter((r) => r.outcome === "anomaly").length,
    3,
  );
  assertProjectionMatchesLedger(after, "eviction");
}

// ---------------------------------------------------------------------------
console.log(
  failures.length === 0
    ? `\nPASS — ${checks} assertions. The ledger converges under duplication and disorder, and the projection matches it exactly.`
    : `\nFAIL — ${failures.length} of ${checks} assertions failed:\n  ${failures.join("\n  ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
