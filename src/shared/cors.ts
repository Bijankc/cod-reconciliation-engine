/**
 * CORS — the seam between Pages and the Worker.
 *
 * The frontend is served by Pages and the API by a Worker. Those are different
 * origins, in development and in production, so every API call the browser makes
 * is a cross-origin request and the browser will discard the response unless the
 * Worker says otherwise. This is the single most common way a dashboard like
 * this one ends up silently blank: the request succeeds, the Worker logs a 200,
 * and the browser throws the body away without telling the page anything useful.
 *
 * Three decisions, each of which has a failure mode that only shows up in a
 * browser and never in `curl`:
 *
 * 1. ALLOWLIST, NEVER `*`. The reflected origin is checked against an explicit
 *    list. `*` would make the API callable from any page on the internet, and it
 *    is also incompatible with credentialed requests, so it forecloses ever
 *    adding a session cookie without a rewrite.
 *
 * 2. `Vary: Origin`, ALWAYS. The response headers depend on the request's
 *    Origin, so any cache in the path must key on it. Without this, a cache can
 *    serve a response containing origin A's `Access-Control-Allow-Origin` to a
 *    request from origin B, which fails in a way that looks like an intermittent
 *    CORS bug and is nearly impossible to reproduce. It is set even when the
 *    origin is rejected, because that response is origin-dependent too.
 *
 * 3. PREFLIGHT IS ANSWERED BEFORE ROUTING, AND WITHOUT AUTH. A preflight is an
 *    `OPTIONS` request the browser sends on its own; it carries no credentials
 *    and no body. Routing it would produce a 405 from a handler expecting POST,
 *    and authenticating it would produce a 401 — either way the browser reports
 *    a CORS failure and the real request is never sent.
 *
 * `Authorization` is in the allowed header list because the Phase 6 simulator
 * posts to `/webhook/courier` with the courier bearer token, and a request
 * carrying that header is never a "simple request" — it always preflights.
 */

import type { Env } from "../env.d.ts";

/** Local defaults: the Pages dev server, on both hostnames a browser might use. */
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:8789",
  "http://127.0.0.1:8789",
] as const;

const ALLOWED_METHODS = "GET, POST, OPTIONS";
const ALLOWED_HEADERS = "content-type, authorization";

/** How long a browser may cache the preflight result. Chrome caps this at 2h. */
const PREFLIGHT_MAX_AGE = "7200";

function allowedOrigins(env: Env): string[] {
  const configured = env.ALLOWED_ORIGINS;
  if (!configured) return [...DEFAULT_ALLOWED_ORIGINS];
  return configured
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * The headers this request's response needs. Empty when there is no Origin —
 * a non-browser caller (curl, the courier, the test scripts) is not doing CORS
 * and should not have CORS headers invented for it.
 */
export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin");
  if (origin === null) return {};

  // Vary regardless of the verdict: the rejection is origin-dependent too.
  const headers: Record<string, string> = { vary: "Origin" };
  if (allowedOrigins(env).includes(origin)) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

/**
 * Answer a preflight, or return null if this is not one. Called first in the
 * fetch handler, ahead of the router and ahead of any auth check.
 */
export function handlePreflight(request: Request, env: Env): Response | null {
  if (request.method.toUpperCase() !== "OPTIONS") return null;
  if (request.headers.get("access-control-request-method") === null) return null;

  const headers = corsHeaders(request, env);

  // A disallowed origin gets a preflight with no allow-origin header. The
  // browser blocks the real request, which is the correct outcome and a clearer
  // signal in devtools than a 403 body the page can never read.
  if (headers["access-control-allow-origin"] !== undefined) {
    headers["access-control-allow-methods"] = ALLOWED_METHODS;
    headers["access-control-allow-headers"] = ALLOWED_HEADERS;
    headers["access-control-max-age"] = PREFLIGHT_MAX_AGE;
  }

  return new Response(null, { status: 204, headers });
}

/**
 * Copy the CORS headers onto a finished response. A Response's headers are
 * immutable once constructed, so this rebuilds it rather than mutating in place.
 */
export function withCors(response: Response, request: Request, env: Env): Response {
  const headers = corsHeaders(request, env);
  if (Object.keys(headers).length === 0) return response;

  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}
