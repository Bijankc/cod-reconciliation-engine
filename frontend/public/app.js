/**
 * COD Reconciliation — the merchant console.
 *
 * Static, no build step: Pages serves this directory and it talks to the Worker
 * cross-origin. Two things follow from that and shape the whole file.
 *
 * 1. THE VOCABULARY IS FETCHED, NOT HARDCODED. `src/shared/constants.ts` is the
 *    single source of truth for the currency, the statuses and the discrepancy
 *    explanations, and its rule is that nothing re-declares them. A static page
 *    cannot import TypeScript, so it reads them from `GET /health` at boot. The
 *    rule survives the language boundary by crossing it over HTTP.
 *
 * 2. THE ZONE LABELS ARE THE API'S OWN WORDS. Every response carries `source`
 *    and `consistency`; the panels print what they were given rather than
 *    asserting something the page believes. If a read ever starts coming from
 *    somewhere else, the label changes by itself.
 */

const API =
  new URLSearchParams(location.search).get("api") ?? "http://127.0.0.1:8788";

/** Slow enough to be polite, fast enough that convergence is watchable. */
const POLL_MS = 2000;

/** Filled from GET /health before the first render. */
let vocab = null;

/** Detail view only: whether to pay for the Durable Object read. */
let compareWithLedger = false;

let pollTimer = null;
let lastGoodAt = null;

/** The most recent detail payload's order row, for the simulator to read. */
let lastDetailOrder = null;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, options);
  } catch (cause) {
    // A blocked cross-origin response and a dead server are indistinguishable
    // here by design — the browser withholds the difference from the page. So
    // the message names both, because guessing wrong costs an hour.
    throw new ApiError("unreachable", 0, null);
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(body?.error ?? `HTTP ${response.status}`, response.status, body);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Indian digit grouping, which is what a Nepali merchant reads. */
function money(amount) {
  const symbol = vocab?.currency?.symbol ?? "Rs.";
  return `${symbol} ${Number(amount ?? 0).toLocaleString("en-IN")}`;
}

function words(value) {
  return String(value ?? "").replace(/_/g, " ").toLowerCase();
}

/** Local wall-clock, seconds included: the demo is about things arriving late. */
function clockTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

const FLAGGED = () => vocab?.flagged_reconciliation_statuses ?? ["DISCREPANCY"];

function isFlagged(status) {
  return FLAGGED().includes(status);
}

/** Which of the four tones a reconciliation verdict wears. */
function reconTone(status) {
  if (isFlagged(status)) return "flag";
  if (status === "FULLY_COLLECTED") return "settled";
  if (status === "PARTIALLY_COLLECTED" || status === "AWAITING_CONFIRMATION") return "held";
  return "neutral";
}

function barColor(status) {
  const tone = reconTone(status);
  if (tone === "flag") return "var(--flag)";
  if (tone === "settled") return "var(--settled)";
  if (tone === "held") return "var(--held)";
  return "var(--ink-faint)";
}

function badge(text, tone) {
  const attr = tone && tone !== "neutral" ? ` data-tone="${tone}"` : "";
  return `<span class="badge"${attr}>${escapeHtml(text)}</span>`;
}

function reconBadge(order) {
  const flagged = isFlagged(order.reconciliation_status);
  const label = `${flagged ? "🚩 " : ""}${words(order.reconciliation_status)}`;
  const explanation =
    flagged && order.discrepancy_reason
      ? `<span class="reason">${escapeHtml(
          vocab?.discrepancy_reason_text?.[order.discrepancy_reason] ??
            words(order.discrepancy_reason),
        )}</span>`
      : "";
  return badge(label, reconTone(order.reconciliation_status)) + explanation;
}

/**
 * THE SIGNATURE. Collected and expected on ONE shared scale, so the expected
 * line sits where the obligation ends and an overpayment physically overshoots
 * it. The ledger never clamps at cod_amount; neither does its picture.
 */
function reconciliationBar(order) {
  const expected = Number(order.cod_amount ?? 0);
  const collected = Number(order.amount_collected ?? 0);
  const scale = Math.max(expected, collected, 1);

  const gap = expected - collected;
  let note = "";
  if (gap > 0 && collected > 0) {
    note = ` <span class="recbar__gap">${money(gap)} short</span>`;
  } else if (gap < 0) {
    note = ` <span class="recbar__gap">${money(-gap)} over</span>`;
  }

  return `
    <div class="recbar">
      <div class="recbar__track"
           style="--collected-pct:${(collected / scale) * 100};--expected-pct:${
             (expected / scale) * 100
           };--bar-color:${barColor(order.reconciliation_status)}">
        <div class="recbar__fill"></div>
        <div class="recbar__expected"></div>
      </div>
      <div class="recbar__figures">
        <b>${escapeHtml(money(collected))}</b> of ${escapeHtml(money(expected))}${note}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Freshness + failure
// ---------------------------------------------------------------------------

function markFresh() {
  lastGoodAt = Date.now();
  const el = $("freshness");
  el.dataset.state = "live";
  el.dataset.pulse = "on";
  el.textContent = `updated ${clockTime(new Date().toISOString())}`;
  setTimeout(() => el.removeAttribute("data-pulse"), 620);
  $("alert").hidden = true;
}

function markFailed(error) {
  const el = $("freshness");
  el.dataset.state = "down";
  el.textContent = lastGoodAt ? "reconnecting" : "no connection";

  const alert = $("alert");
  alert.hidden = false;
  alert.innerHTML =
    error.status === 0
      ? `<strong>Can't reach the API at <code>${escapeHtml(API)}</code>.</strong>
         Either the Worker isn't running — start it with <code>npm run dev</code> — or this
         page's origin isn't in the Worker's <code>ALLOWED_ORIGINS</code>, in which case the
         browser is discarding the response before the page ever sees it. Point somewhere
         else by adding <code>?api=http://host:port</code> to this URL.`
      : `<strong>The API returned an error.</strong> ${escapeHtml(error.message)}`;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function renderSummary(orders) {
  const expected = orders.reduce((sum, o) => sum + Number(o.cod_amount ?? 0), 0);
  const collected = orders.reduce((sum, o) => sum + Number(o.amount_collected ?? 0), 0);
  const flagged = orders.filter((o) => isFlagged(o.reconciliation_status)).length;
  const settled = orders.filter((o) => o.reconciliation_status === "FULLY_COLLECTED").length;

  $("summary").innerHTML = `
    <div class="tally">
      <p class="tally__label">Expected</p>
      <p class="tally__value">${escapeHtml(money(expected))}</p>
      <p class="tally__note">${orders.length} order${orders.length === 1 ? "" : "s"}</p>
    </div>
    <div class="tally">
      <p class="tally__label">Collected</p>
      <p class="tally__value">${escapeHtml(money(collected))}</p>
      <p class="tally__note">${escapeHtml(money(Math.max(expected - collected, 0)))} still out</p>
    </div>
    <div class="tally">
      <p class="tally__label">Settled</p>
      <p class="tally__value">${settled}</p>
      <p class="tally__note">delivered and paid in full</p>
    </div>
    <div class="tally${flagged > 0 ? " tally--flagged" : ""}">
      <p class="tally__label">${flagged > 0 ? "🚩 Needs a call" : "Needs a call"}</p>
      <p class="tally__value">${flagged}</p>
      <p class="tally__note">${
        flagged > 0 ? "money and delivery disagree" : "nothing to chase"
      }</p>
    </div>`;
}

function renderOrders(orders) {
  const body = $("orders-body");

  if (orders.length === 0) {
    body.innerHTML = `
      <tr><td colspan="5" class="empty">
        <strong>No orders yet.</strong>
        Create one on the left, then send it courier events to watch the ledger reconcile.
      </td></tr>`;
    return;
  }

  body.innerHTML = orders
    .map(
      (order) => `
      <tr data-flagged="${isFlagged(order.reconciliation_status)}">
        <td><a class="order-link" href="#/orders/${encodeURIComponent(
          order.order_id,
        )}">${escapeHtml(order.order_id)}</a></td>
        <td class="customer">${escapeHtml(order.customer_name)}</td>
        <td>${reconciliationBar(order)}</td>
        <td>${badge(words(order.current_status), order.current_status === "RETURNED" ? "held" : "neutral")}</td>
        <td>${reconBadge(order)}</td>
      </tr>`,
    )
    .join("");
}

/**
 * Dead letters, shown only when there are any.
 *
 * An empty panel that says "no poison events" every day forever is noise; the
 * absence of dead letters is the normal case and does not need reporting. When
 * one does appear it deserves to be impossible to miss, which is why this
 * mounts above the order table rather than below it.
 */
function renderDeadLetters(data) {
  const panel = $("dead-letters");

  if (data.count === 0) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }

  panel.hidden = false;
  panel.innerHTML = `
    <div class="panel__head">
      <div>
        <p class="eyebrow">Dead-letter queue</p>
        <h2 class="panel__title">
          ${data.count} message${data.count === 1 ? "" : "s"} the pipeline could not process
        </h2>
      </div>
      <p class="zone">${words(data.source)}</p>
    </div>
    <div class="dlq__body">
      <p class="panel__lede">
        Each of these failed every retry and was moved aside so it could not block the queue
        behind it. The ledger never saw them and no money moved.
      </p>
      <ul class="held-list">
        ${data.dead_letters
          .map(
            (row) => `<li>
              ${escapeHtml(row.type ?? "unknown")} · ${escapeHtml(row.event_id)}
              · ${escapeHtml(clockTime(row.dead_lettered_at))}
              · ${escapeHtml(words(row.reason))}
            </li>`,
          )
          .join("")}
      </ul>
    </div>`;
}

async function loadDashboard() {
  // Two independent reads, issued together. The dead-letter table is almost
  // always empty, so this costs a round trip and nothing else.
  const [data, deadLetters] = await Promise.all([
    api("/api/orders?limit=100"),
    api("/api/dead-letters"),
  ]);

  renderSummary(data.orders);
  renderOrders(data.orders);
  renderDeadLetters(deadLetters);
  $("dashboard-zone").textContent = `${words(data.source)} · ${data.consistency}`;
}

// ---------------------------------------------------------------------------
// Order detail
// ---------------------------------------------------------------------------

function renderLedgerBook(authoritative) {
  const state = authoritative?.state ?? null;

  // Two different empty states that look identical in the data and mean opposite
  // things to a merchant. "Nothing has happened" is reassuring; "events have
  // arrived and none of them could be applied" is the thing worth looking at.
  if (state === null) {
    const seen = authoritative?.processed_count ?? 0;
    const held = authoritative?.pending?.length ?? 0;

    return seen === 0
      ? `
      <div class="panel book book--authoritative">
        <p class="eyebrow">Authoritative</p>
        <h2 class="panel__title">No ledger yet</h2>
        <p class="panel__lede">
          This order exists, but no courier event has reached it. The Durable Object is
          created by the first event, not by the order.
        </p>
      </div>`
      : `
      <div class="panel book book--authoritative">
        <p class="eyebrow">Authoritative</p>
        <h2 class="panel__title">Nothing applied yet</h2>
        <p class="panel__lede">
          The ledger has seen ${seen} event${seen === 1 ? "" : "s"} and applied none of them.
          ${held > 0 ? `${held} ${held === 1 ? "is" : "are"} held below, waiting on the event ${held === 1 ? "it depends" : "they depend"} on.` : ""}
          No money has moved.
        </p>
      </div>`;
  }

  return `
    <div class="panel book book--authoritative">
      <div class="panel__head" style="padding:0 0 .75rem;border:0">
        <div>
          <p class="eyebrow">Authoritative</p>
          <h2 class="panel__title">The ledger</h2>
        </div>
        ${badge("durable object · strong", "cp")}
      </div>
      <div class="book__figures">
        <div>
          <p class="figure__label">Collected</p>
          <p class="figure__value">${escapeHtml(money(state.amount_collected))}</p>
        </div>
        <div>
          <p class="figure__label">Delivery</p>
          <p class="figure__value" style="font-size:.9375rem">${escapeHtml(
            words(state.status),
          )}</p>
        </div>
        <div>
          <p class="figure__label">Version</p>
          <p class="figure__value">${state.version}</p>
        </div>
      </div>
    </div>`;
}

function renderDivergence(divergence) {
  if (!divergence) return "";

  const behind = divergence.versions_behind;
  return `
    <div class="divergence" data-converged="${divergence.converged}">
      <span>${
        divergence.converged
          ? "The read model matches the ledger exactly."
          : `The read model is <b>${behind}</b> event${behind === 1 ? "" : "s"} behind. It catches up on its own.`
      }</span>
      <span>projected <b>v${divergence.projected_version}</b> · ledger <b>v${
        divergence.authoritative_version
      }</b></span>
      ${
        divergence.diverged_fields.length > 0
          ? `<span>differs on <b>${escapeHtml(divergence.diverged_fields.join(", "))}</b></span>`
          : ""
      }
    </div>`;
}

function renderHeldEvents(pending) {
  if (!pending || pending.length === 0) return "";
  return `
    <div class="panel book" style="margin-bottom:1.25rem">
      <p class="eyebrow">Pending buffer</p>
      <h2 class="panel__title">Held until they make sense</h2>
      <p class="panel__lede">
        These arrived before the event they depend on. The ledger is holding them and retries
        them every time the order advances.
      </p>
      <ul class="held-list">
        ${pending
          .map(
            (event) =>
              `<li>${escapeHtml(event.type)} · ${escapeHtml(event.event_id)}</li>`,
          )
          .join("")}
      </ul>
    </div>`;
}

function renderTimeline(timeline) {
  if (timeline.length === 0) {
    return `<div class="empty"><strong>No events yet.</strong>
      Nothing has been reported by a courier for this order.</div>`;
  }

  const tone = { applied: "settled", buffered: "held", anomaly: "flag" };

  return `
    <table class="timeline">
      <thead>
        <tr>
          <th scope="col">Event</th>
          <th scope="col">Verdict</th>
          <th scope="col">Amount</th>
          <th scope="col">Happened</th>
          <th scope="col">Received</th>
          <th scope="col">Payload</th>
        </tr>
      </thead>
      <tbody>
        ${timeline
          .map(
            (row) => `
          <tr>
            <td>
              <span class="event-type">${escapeHtml(row.type)}</span>
              ${
                row.delivery_count > 1
                  ? `<span class="repeat" title="Delivered to the pipeline ${row.delivery_count} times; applied once">×${row.delivery_count}</span>`
                  : ""
              }
              <br /><span class="stamp">${escapeHtml(row.event_id)}</span>
            </td>
            <td>${badge(row.outcome, tone[row.outcome] ?? "neutral")}</td>
            <td class="money-cell">${row.amount === null ? "—" : escapeHtml(money(row.amount))}</td>
            <td class="stamp">${escapeHtml(clockTime(row.occurred_at))}</td>
            <td class="stamp">${escapeHtml(clockTime(row.received_at))}</td>
            <td>
              <a class="raw-link" target="_blank" rel="noopener"
                 href="${API}/api/orders/${encodeURIComponent(
                   row.order_id,
                 )}/audit?event_id=${encodeURIComponent(row.event_id)}">raw</a>
            </td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

function renderOrphans(orphans) {
  if (!orphans || orphans.length === 0) return "";
  return `
    <div class="panel book" style="margin-top:1.25rem">
      <p class="eyebrow">Unmatched</p>
      <h2 class="panel__title">Events that arrived before this order existed</h2>
      <p class="panel__lede">
        Recorded and audited, but never applied — there was no order to apply them to.
      </p>
      <ul class="held-list">
        ${orphans
          .map((event) => `<li>${escapeHtml(event.type)} · ${escapeHtml(event.event_id)}</li>`)
          .join("")}
      </ul>
    </div>`;
}

/**
 * The detail view is rendered in TWO pieces, and the split is load-bearing.
 *
 * The shell — header, the compare switch, the simulator — is mounted ONCE per
 * order and never touched again. The live region is replaced on every two-second
 * poll. Rebuilding the whole subtree on a timer would destroy any input the user
 * was typing into the simulator's custom-event form twice a minute, and would
 * throw away keyboard focus with it. Anything that holds user input has to live
 * on the side of this line that does not get rebuilt.
 */
let mountedDetailFor = null;

function detailShell(order) {
  return `
    <div class="detail-head">
      <h1>${escapeHtml(order.order_id)}</h1>
      <p>${escapeHtml(order.customer_name)} · merchant ${escapeHtml(
        order.merchant_id,
      )} · booked ${escapeHtml(clockTime(order.created_at))}</p>
    </div>

    <div id="sim-slot"></div>

    <label class="switch" for="compare">
      <input type="checkbox" id="compare" ${compareWithLedger ? "checked" : ""} />
      <span class="switch__text">
        <strong>Compare with the ledger</strong>
        <span>
          Reads the Durable Object directly instead of the D1 projection. Costs a round trip,
          so the dashboard never does it — this page does it on request.
        </span>
      </span>
    </label>

    <div id="detail-live"></div>`;
}

function detailLive(data) {
  const order = data.order;
  return `
    ${compareWithLedger ? renderDivergence(data.divergence) : ""}

    <div class="compare">
      <div class="panel book">
        <div class="panel__head" style="padding:0 0 .75rem;border:0">
          <div>
            <p class="eyebrow">Projected</p>
            <h2 class="panel__title">What the dashboard reads</h2>
          </div>
          ${badge(`${words(data.source)} · ${data.consistency}`, "neutral")}
        </div>
        <div class="book__figures">
          <div>
            <p class="figure__label">Expected</p>
            <p class="figure__value">${escapeHtml(money(order.cod_amount))}</p>
          </div>
          <div>
            <p class="figure__label">Collected</p>
            <p class="figure__value">${escapeHtml(money(order.amount_collected))}</p>
          </div>
          <div>
            <p class="figure__label">Version</p>
            <p class="figure__value">${order.projection_version}</p>
          </div>
        </div>
        <div style="margin-top:1rem">${reconciliationBar(order)}</div>
        <div style="margin-top:.85rem">
          ${badge(words(order.current_status), "neutral")} ${reconBadge(order)}
        </div>
      </div>

      ${compareWithLedger ? renderLedgerBook(data.authoritative) : ""}
    </div>

    ${compareWithLedger ? renderHeldEvents(data.authoritative?.pending) : ""}

    <section class="panel">
      <div class="panel__head">
        <div>
          <p class="eyebrow">Timeline</p>
          <h2 class="panel__title">Every event, and what the ledger did with it</h2>
        </div>
        <p class="zone">newest first</p>
      </div>
      <div class="table-scroll">${renderTimeline(data.timeline)}</div>
    </section>

    ${renderOrphans(data.orphan_events)}`;
}

async function loadDetail(orderId) {
  const query = compareWithLedger ? "?authoritative=true" : "";
  const data = await api(`/api/orders/${encodeURIComponent(orderId)}${query}`);

  if (mountedDetailFor !== orderId) {
    $("detail-body").innerHTML = detailShell(data.order);
    mountedDetailFor = orderId;

    $("compare").addEventListener("change", (event) => {
      compareWithLedger = event.target.checked;
      refresh();
    });

    // The simulator is a separate concern in a separate file. It mounts once,
    // holds its own state, and asks for a refresh when it has sent something.
    if (window.Simulator) {
      window.Simulator.mount($("sim-slot"), {
        api: API,
        orderId,
        getOrder: () => lastDetailOrder,
        onSent: () => refresh(),
      });
    }
  }

  lastDetailOrder = data.order;
  $("detail-live").innerHTML = detailLive(data);
}

// ---------------------------------------------------------------------------
// Order form
// ---------------------------------------------------------------------------

function clearFieldErrors() {
  document.querySelectorAll("[data-error-for]").forEach((el) => (el.textContent = ""));
}

async function submitOrder(event) {
  event.preventDefault();
  clearFieldErrors();

  const button = $("create-button");
  button.disabled = true;

  const amount = $("cod_amount").value.trim();
  const payload = {
    customer_name: $("customer_name").value.trim(),
    merchant_id: $("merchant_id").value.trim(),
    // Send a number so the API's "whole NPR integers" rule judges a number,
    // not a string that happens to look like one.
    cod_amount: amount === "" ? null : Number(amount),
  };

  try {
    const created = await api("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const receipt = $("form-receipt");
    receipt.hidden = false;
    receipt.innerHTML = `Order created — <code>${escapeHtml(created.order_id)}</code>.
      <a href="#/orders/${encodeURIComponent(created.order_id)}">Open it</a>`;

    $("customer_name").value = "";
    $("cod_amount").value = "";
    $("customer_name").focus();
    await refresh();
  } catch (error) {
    if (error.body?.details) {
      for (const detail of error.body.details) {
        const target = document.querySelector(`[data-error-for="${detail.field}"]`);
        if (target) target.textContent = detail.message;
      }
    } else {
      markFailed(error);
    }
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Routing + polling
// ---------------------------------------------------------------------------

function currentOrderId() {
  const match = /^#\/orders\/(.+)$/.exec(location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}

async function refresh() {
  const orderId = currentOrderId();
  try {
    if (orderId === null) {
      await loadDashboard();
    } else {
      await loadDetail(orderId);
    }
    markFresh();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && orderId !== null) {
      $("detail-body").innerHTML = `<div class="empty">
        <strong>No such order.</strong> It may have been created against a different API.</div>`;
      markFresh();
      return;
    }
    markFailed(error);
  }
}

function route() {
  const orderId = currentOrderId();
  $("view-dashboard").hidden = orderId !== null;
  $("view-detail").hidden = orderId === null;
  // The comparison is opt-in per order, not a sticky global preference.
  if (orderId === null) compareWithLedger = false;
  // Leaving the detail view, or switching orders, drops the mounted shell so the
  // next visit rebuilds it (and remounts the simulator against the new order).
  if (orderId !== mountedDetailFor) mountedDetailFor = null;
  refresh();
}

/** Fetch the vocabulary. Until this succeeds the page cannot format anything. */
async function loadVocabulary() {
  vocab = await api("/health");
  // The simulator reads its event-type list from here too, for the same reason
  // the rest of the page does: the enum lives in one place and is fetched, not
  // copied (Decision 13).
  window.__vocabulary = vocab;
  $("unit-hint").textContent = `· ${vocab.currency.code}, whole rupees`;
}

/**
 * One tick of the poll, and the only place the interval calls into. If the
 * Worker was down at boot, the tick keeps retrying the vocabulary so the page
 * heals itself when the server comes up instead of demanding a reload.
 */
async function tick() {
  if (vocab === null) {
    try {
      await loadVocabulary();
    } catch (error) {
      markFailed(error);
      return;
    }
  }
  await refresh();
}

function startPolling() {
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = setInterval(tick, POLL_MS);
}

async function boot() {
  $("api-base").textContent = API;
  $("order-form").addEventListener("submit", submitOrder);
  window.addEventListener("hashchange", route);

  try {
    await loadVocabulary();
    route();
  } catch (error) {
    markFailed(error);
  }

  startPolling();
}

// Stop polling when the tab is hidden; catch up immediately when it returns.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(pollTimer);
    pollTimer = null;
  } else {
    tick();
    startPolling();
  }
});

boot();
