/**
 * Every request the console makes, replayed with browser headers.
 *
 * What this can and cannot do, stated honestly: a browser ENFORCES CORS, and
 * this script cannot. What it can do is assert that every header a browser
 * requires is present and correct on every endpoint the console actually calls,
 * which is where this goes wrong in practice. A missing `Access-Control-Allow-Origin`
 * on one route out of six is invisible to `curl`, invisible in the Worker's logs,
 * and shows up in the browser as a blank panel with no error the page can catch.
 *
 * It also checks the negative case, which is the half people forget: a
 * disallowed origin must NOT be reflected. An allowlist that accidentally
 * reflects everything passes every positive test ever written.
 *
 * Run with both servers up:  npm run verify:cors
 */

const API = process.env.BASE_URL ?? "http://127.0.0.1:8788";
const ORIGIN = process.env.CONSOLE_ORIGIN ?? "http://127.0.0.1:8789";
const IMPOSTOR = "https://not-the-console.example";

const failures = [];
let checks = 0;

function check(label, ok, detail) {
  checks++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    if (detail !== undefined) console.log(`        ${detail}`);
    failures.push(label);
  }
}

/** Assert the headers a browser needs before it will hand the body to the page. */
async function assertCorsOn(label, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { origin: ORIGIN, ...(init.headers ?? {}) },
  });

  const allow = response.headers.get("access-control-allow-origin");
  const vary = response.headers.get("vary") ?? "";

  check(`${label}: responded ${response.status}`, response.ok, `got ${response.status}`);
  check(`${label}: allow-origin echoes the console`, allow === ORIGIN, `got ${allow}`);
  check(`${label}: varies on Origin`, /origin/i.test(vary), `got "${vary}"`);
  return response;
}

/** The OPTIONS the browser sends by itself before a non-simple request. */
async function assertPreflight(label, path, method, requestHeaders) {
  const response = await fetch(`${API}${path}`, {
    method: "OPTIONS",
    headers: {
      origin: ORIGIN,
      "access-control-request-method": method,
      "access-control-request-headers": requestHeaders,
    },
  });

  const allow = response.headers.get("access-control-allow-origin");
  const methods = response.headers.get("access-control-allow-methods") ?? "";
  const headers = (response.headers.get("access-control-allow-headers") ?? "").toLowerCase();

  check(`${label} preflight: 204`, response.status === 204, `got ${response.status}`);
  check(`${label} preflight: allow-origin`, allow === ORIGIN, `got ${allow}`);
  check(`${label} preflight: allows ${method}`, methods.includes(method), `got "${methods}"`);
  for (const header of requestHeaders.split(",").map((h) => h.trim())) {
    check(
      `${label} preflight: allows the ${header} header`,
      headers.includes(header),
      `got "${headers}"`,
    );
  }
}

console.log(`CORS check — console ${ORIGIN} calling API ${API}\n`);

console.log("1. Boot: the console fetches its vocabulary");
const health = await assertCorsOn("GET /health", "/health");
const vocabulary = await health.json();
check(
  "GET /health: carries the currency the page formats with",
  vocabulary?.currency?.symbol !== undefined,
  JSON.stringify(vocabulary?.currency),
);

console.log("\n2. Dashboard: the polled list read");
await assertCorsOn("GET /api/orders", "/api/orders?limit=100");

console.log("\n3. Order form: a JSON POST, which always preflights");
await assertPreflight("POST /api/orders", "/api/orders", "POST", "content-type");
const created = await assertCorsOn("POST /api/orders", "/api/orders", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    customer_name: "CORS Probe",
    merchant_id: "m1",
    cod_amount: 1234,
  }),
});
const { order_id: orderId } = await created.json();
check("POST /api/orders: returned an order_id", typeof orderId === "string", orderId);

console.log("\n4. Order detail, both zones");
await assertCorsOn("GET /api/orders/:id", `/api/orders/${orderId}`);
await assertCorsOn(
  "GET /api/orders/:id?authoritative=true",
  `/api/orders/${orderId}?authoritative=true`,
);

console.log("\n5. Audit listing");
await assertCorsOn("GET /api/orders/:id/audit", `/api/orders/${orderId}/audit`);

console.log("\n6. The webhook, which the Phase 6 simulator will call with a bearer token");
await assertPreflight(
  "POST /webhook/courier",
  "/webhook/courier",
  "POST",
  "content-type, authorization",
);

console.log("\n7. The negative case: an origin that is NOT on the allowlist");
{
  const response = await fetch(`${API}/api/orders`, { headers: { origin: IMPOSTOR } });
  const allow = response.headers.get("access-control-allow-origin");
  const vary = response.headers.get("vary") ?? "";
  check("impostor origin: not reflected", allow === null, `got ${allow}`);
  check("impostor origin: still varies on Origin", /origin/i.test(vary), `got "${vary}"`);

  const preflight = await fetch(`${API}/api/orders`, {
    method: "OPTIONS",
    headers: { origin: IMPOSTOR, "access-control-request-method": "POST" },
  });
  check(
    "impostor preflight: no allow-origin",
    preflight.headers.get("access-control-allow-origin") === null,
    `got ${preflight.headers.get("access-control-allow-origin")}`,
  );
}

console.log("\n8. A non-browser caller gets no CORS headers invented for it");
{
  const response = await fetch(`${API}/health`);
  check(
    "no Origin header: no allow-origin in the response",
    response.headers.get("access-control-allow-origin") === null,
    `got ${response.headers.get("access-control-allow-origin")}`,
  );
}

console.log(
  failures.length === 0
    ? `\nPASS — ${checks} assertions. The CORS LOGIC is correct on every endpoint the console
calls: the headers a browser requires are present, and a disallowed origin is not reflected.

NOT the same claim as "the dashboard works in a browser". No same-origin policy was enforced
here — this harness sends browser-SHAPED headers, it is not a browser. Confirm the real calls
in dev-tools before describing browser CORS as working.`
    : `\nFAIL — ${failures.length} of ${checks} assertions failed:\n  ${failures.join("\n  ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
