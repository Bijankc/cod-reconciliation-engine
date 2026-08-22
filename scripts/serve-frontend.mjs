/**
 * A static file server for the console, on its own origin.
 *
 * Why not `wrangler pages dev`: it merges the Worker's `wrangler.jsonc` bindings
 * into the Pages project even when the Pages project has its own config, and
 * then refuses to start because the Pages entry shim does not export the
 * `OrderLedger` Durable Object. There is no supported way to tell it not to —
 * `wrangler pages dev --config` is explicitly rejected.
 *
 * That is a tooling problem, not a design problem. The console is three static
 * files; Pages serves exactly those bytes in production, and `npm run deploy:frontend`
 * still deploys it as a real Pages project. What matters for development is the
 * property this server preserves and a same-origin shortcut would destroy: the
 * page is served from a DIFFERENT ORIGIN than the API, so every call it makes is
 * genuinely cross-origin and genuinely preflighted. Serving the frontend from
 * the Worker would make the dashboard work locally and fail on deploy, which is
 * the exact bug this arrangement exists to prevent.
 *
 * Run: npm run frontend
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("../frontend/public", import.meta.url)));
const PORT = Number(process.env.PORT ?? 8789);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;

  // Resolve inside ROOT and reject anything that climbs out of it.
  const path = join(ROOT, normalize(requested).replace(/^(\.\.[/\\])+/, ""));
  if (!path.startsWith(ROOT + sep)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const body = await readFile(path);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
      // Always fresh: this is a dev server and a stale app.js during a demo is
      // an unexplainable bug.
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Console:  http://127.0.0.1:${PORT}`);
  console.log(`Serving:  ${ROOT}`);
  console.log(`API:      expects the Worker on http://127.0.0.1:8788 (override with ?api=)`);
  console.log(`\nThis origin must appear in the Worker's ALLOWED_ORIGINS, or the browser`);
  console.log(`will discard every response before the page can read it.`);
});
