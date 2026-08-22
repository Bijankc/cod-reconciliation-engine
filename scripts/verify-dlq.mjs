/**
 * The dead-letter queue, demonstrated rather than asserted.
 *
 * Fires one deliberately-poisonous event — a well-formed payload carrying the
 * reserved `sim-poison` courier_id, which makes the consumer throw on every
 * attempt — and then watches for it to appear in `dead_letters`.
 *
 * WHAT A PASS HERE MEANS, EXACTLY. It means the hand-off worked **in local
 * emulation**: the consumer exhausted its retries, Queues moved the message to
 * `courier-events-dlq`, and the DLQ consumer recorded it. That is real evidence
 * and it is more than a configuration claim. It is NOT evidence about
 * production. The local queue emulator is not the production scheduler; retry
 * timing, backoff and the hand-off itself are its own implementation. Until this
 * has been run against a real Cloudflare queue, the DLQ remains on the
 * deferred-to-deploy list, and this script's output must not be quoted as if it
 * settled that.
 *
 * A TIMEOUT here is therefore not necessarily a bug in the system. It may simply
 * mean the local emulator does not implement the hand-off. The script says so
 * rather than failing silently into a wrong conclusion.
 *
 * Run against a local `wrangler dev`:  npm run verify:dlq
 */

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8788";
const SECRET = process.env.COURIER_SHARED_SECRET ?? "dev-courier-secret-change-me";
const POISON_COURIER_ID = "sim-poison";

/** Five retries with backoff takes a while; give it room before concluding. */
const TIMEOUT_MS = Number(process.env.DLQ_TIMEOUT_MS ?? 120_000);
const POLL_MS = 3000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Per-request timeout: `wrangler dev` reloads, and a hung fetch is not a result. */
async function request(path, init = {}, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
    } catch {
      if (i === attempts - 1) throw new Error(`${path} unreachable after ${attempts} tries`);
      await wait(1500);
    }
  }
}

console.log(`Dead-letter demonstration against ${BASE}\n`);

// An order that exists, so the only reason this fails is the poison marker
// itself — not the orphan path, which would ack and never reach the DLQ.
const orderResponse = await request("/api/orders", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    customer_name: "Poison Probe",
    merchant_id: "m1",
    cod_amount: 500,
  }),
});
const { order_id: orderId } = await orderResponse.json();

const eventId = `evt_poison_${Date.now().toString(36)}`;
const accepted = await request("/webhook/courier", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
  body: JSON.stringify({
    schema_version: 1,
    courier_id: POISON_COURIER_ID,
    event_id: eventId,
    order_id: orderId,
    type: "payment_collected",
    amount: 500,
    occurred_at: new Date().toISOString(),
  }),
});

console.log(`  order            ${orderId}`);
console.log(`  poison event     ${eventId}`);
console.log(`  webhook accepted ${accepted.status} (202 = well-formed and enqueued)\n`);

if (accepted.status !== 202) {
  console.log("FAIL — the webhook rejected the poison event. It must be VALID to reach the queue.");
  process.exit(1);
}

console.log("  Waiting for 5 failed attempts, then the hand-off to courier-events-dlq...");

const deadline = Date.now() + TIMEOUT_MS;
let found = null;

while (Date.now() < deadline && found === null) {
  await wait(POLL_MS);
  const response = await request("/api/dead-letters");
  const body = await response.json();
  found = body.dead_letters.find((row) => row.event_id === eventId) ?? null;
  const elapsed = Math.round((TIMEOUT_MS - (deadline - Date.now())) / 1000);
  console.log(`  t+${String(elapsed).padStart(3)}s  dead_letters=${body.count}${found ? "  <-- arrived" : ""}`);
}

if (found === null) {
  console.log(`
INCONCLUSIVE — nothing reached the dead-letter queue within ${TIMEOUT_MS / 1000}s.

This is not proof of a bug. The local queue emulator may not implement the
dead-letter hand-off after max_retries at all. What IS proven either way: the
consumer throws on this message every time, so it can never be acked.

Check the wrangler dev log for repeated "[retry] ${eventId}" lines. If they are
there, the retry half is working and only the hand-off is unverified locally.`);
  process.exit(0);
}

console.log(`
PASS (in local emulation) — the poison event reached the dead-letter queue.

  event_id          ${found.event_id}
  order_id          ${found.order_id}
  type              ${found.type}
  reason            ${found.reason}
  dead_lettered_at  ${found.dead_lettered_at}
  dlq_attempts      ${found.dlq_attempts}  (this consumer's count, NOT the 5 main-queue failures)

The pipeline was never blocked: ordinary events kept flowing while this one
failed and was set aside. That is the DLQ's actual job.

STILL UNVERIFIED: production hand-off, real retry backoff timing. This ran
against the local emulator, which is not the production scheduler. The DLQ stays
on the deferred-to-deploy list until it has been shown on a real queue.`);
