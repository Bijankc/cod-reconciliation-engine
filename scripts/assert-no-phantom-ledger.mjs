/**
 * Decision 5's money-safety property, asserted rather than assumed.
 *
 * The orphan_events row proves the orphan path RAN. It does not prove the thing
 * that actually protects money: that `idFromName("ord_ghost")` never brought a
 * Durable Object into existence. A phantom ledger would be silent — no error, no
 * log line, just a DO accruing cash against an order no merchant can see. The
 * only way to know is to look at the set of live DO instances and find it absent.
 *
 * Run against a local `wrangler dev`:  npm run assert:no-phantom
 */

import { execSync } from "node:child_process";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8788";
const SECRET = process.env.COURIER_SHARED_SECRET ?? "dev-courier-secret-change-me";
const NAMESPACE = "cod-reconciliation-engine-OrderLedger";
const GHOST_ORDER = "ord_ghost_phantom_probe";

const failures = [];
const note = (m) => console.log(`  ${m}`);

function d1(sql) {
  const out = execSync(
    `npx wrangler d1 execute cod-recon --local --json --command "${sql.replace(/"/g, '\\"')}"`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}

/** The dev server reloads on file changes; a reset here is noise, not a result. */
async function fetchWithRetry(url, init, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (i === attempts - 1) throw error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function listLedgerInstances() {
  const res = await fetchWithRetry(
    `${BASE}/cdn-cgi/local/explorer/api/workers/durable_objects/namespaces/${NAMESPACE}/objects`,
  );
  const body = await res.json();
  if (!body.success) throw new Error(`DO listing failed: ${JSON.stringify(body.errors)}`);
  return body.result;
}

console.log("Phantom-ledger assertion (Decision 5)\n");

// Baseline: how many ledgers exist before we send anything.
const before = await listLedgerInstances();
note(`ledger instances before: ${before.length}`);

// Fire an event naming an order that has never been created.
const eventId = `evt_phantom_${Date.now()}`;
const res = await fetchWithRetry(`${BASE}/webhook/courier`, {
  method: "POST",
  headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
  body: JSON.stringify({
    event_id: eventId,
    order_id: GHOST_ORDER,
    type: "payment_collected",
    amount: 5000,
    occurred_at: new Date().toISOString(),
    schema_version: 1,
  }),
});
if (res.status !== 202) failures.push(`webhook returned ${res.status}, expected 202`);
note(`webhook accepted the orphan event: ${res.status}`);

// Wait for the consumer to drain. max_batch_timeout is 5s, so a partial batch can
// sit that long before delivery — poll rather than guess a sleep.
let orphans = [];
const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  orphans = d1(`SELECT event_id, reason, raw_r2_key FROM orphan_events WHERE event_id = '${eventId}'`);
  if (orphans.length > 0) break;
  await new Promise((r) => setTimeout(r, 1000));
}

// 1. The orphan path ran.
if (orphans.length !== 1) {
  failures.push(`expected 1 orphan_events row for ${eventId}, found ${orphans.length}`);
} else {
  note(`orphan_events row recorded, reason=${orphans[0].reason}`);
  if (!orphans[0].raw_r2_key) failures.push("orphan row has no audit reference — the audit write did not run first");
}

// 2. It did NOT become an order.
const orders = d1(`SELECT order_id FROM orders WHERE order_id = '${GHOST_ORDER}'`);
if (orders.length !== 0) failures.push(`orphan created an order row — it must never do that`);
else note("no orders row was created");

// 3. It did NOT reach order_events (the FK is what makes this structural).
const events = d1(`SELECT event_id FROM order_events WHERE order_id = '${GHOST_ORDER}'`);
if (events.length !== 0) failures.push(`orphan wrote to order_events — must go to orphan_events only`);
else note("no order_events row was created");

// 4. THE ASSERTION: no ledger was instantiated for it.
const after = await listLedgerInstances();
note(`ledger instances after:  ${after.length}`);

// The inspector reports each instance's NAME, so the assertion can be made
// directly rather than only by counting: no live ledger may be named after the
// order that never existed.
const namedGhost = after.filter((o) => o.name === GHOST_ORDER);
if (namedGhost.length > 0) {
  failures.push(`PHANTOM LEDGER: a Durable Object named "${GHOST_ORDER}" exists`);
}

const created = after.filter((o) => !before.some((b) => b.id === o.id));
if (created.length > 0) {
  failures.push(
    `PHANTOM LEDGER: ${created.length} Durable Object instance(s) appeared while processing an ` +
      `event for a non-existent order: ${created.map((o) => o.id).join(", ")}`,
  );
} else {
  note("no new Durable Object instance appeared — no phantom ledger");
}

console.log("");
if (failures.length > 0) {
  console.error("FAIL:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS — an event for "${GHOST_ORDER}" was audited, orphaned and acked, and`);
console.log("       instantiated no ledger. Decision 5 holds by evidence, not by construction.");
