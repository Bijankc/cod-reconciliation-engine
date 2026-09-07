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
  new URLSearchParams(location.search).get("api") ??
  "https://cod-reconciliation-engine.bijankcbhurtel.workers.dev";

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

/** Six characters is enough to match a row against a courier's spreadsheet. */
function shortId(orderId) {
  return String(orderId ?? "").replace(/^ord_/, "").slice(0, 6);
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

function badge(text, tone, title) {
  const toneAttr = tone && tone !== "neutral" ? ` data-tone="${tone}"` : "";
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<span class="badge"${toneAttr}${titleAttr}>${escapeHtml(text)}</span>`;
}

// ---------------------------------------------------------------------------
// Plain language
//
// The system's vocabulary is precise and the merchant does not speak it. Every
// row therefore carries BOTH: a sentence a shop owner can act on, and the
// ledger's own status underneath it in the machine voice. Neither replaces the
// other — the enum is what the API actually said, and the sentence is what it
// means for the person reading.
// ---------------------------------------------------------------------------

/** Delivery status in the words a merchant would use out loud. */
const DELIVERY_PLAIN = {
  PENDING: "Not sent yet",
  DISPATCHED: "Out for delivery",
  DELIVERED: "Delivered",
  RETURNED: "Came back",
};

/** Courier event types, likewise. */
const EVENT_PLAIN = {
  delivery_attempted: "Courier tried to deliver",
  payment_collected: "Cash collected",
  partial_payment: "Part of the cash collected",
  delivery_confirmed: "Delivery confirmed",
  returned: "Parcel came back to you",
};

/** What the ledger did with an event. */
const OUTCOME_PLAIN = {
  applied: "Counted",
  buffered: "Waiting",
  anomaly: "Not counted",
};

/**
 * The headline and sentence for a row. The headline is an ACTION wherever there
 * is one to take — a merchant opening this page is asking what to do, not what
 * to call it.
 */
function plainVerdict(order) {
  const status = order.reconciliation_status;
  const expected = Number(order.cod_amount ?? 0);
  const collected = Number(order.amount_collected ?? 0);

  if (isFlagged(status)) {
    const reason = order.discrepancy_reason;
    if (reason === "RETURNED_WITH_PAYMENT") {
      return {
        tone: "flag",
        headline: "Get the cash back from the courier",
        sentence: `The parcel came back to you, but the courier still collected ${money(
          collected,
        )} for it. That money is with them, not with you.`,
      };
    }
    if (reason === "OVERPAID") {
      return {
        tone: "flag",
        headline: "Refund the customer",
        sentence: `The customer paid ${money(collected)} on a ${money(
          expected,
        )} order — ${money(collected - expected)} more than they owed.`,
      };
    }
    if (reason === "DELIVERED_UNDERPAID") {
      return {
        tone: "flag",
        headline: "Chase the shortfall",
        sentence: `The parcel was delivered but only ${money(collected)} of ${money(
          expected,
        )} came in. ${money(expected - collected)} is still missing.`,
      };
    }
    return {
      tone: "flag",
      headline: "Needs a call",
      sentence:
        vocab?.discrepancy_reason_text?.[reason] ??
        "The money and the delivery do not agree.",
    };
  }

  if (status === "FULLY_COLLECTED") {
    return {
      tone: "settled",
      headline: "Settled",
      sentence: "Delivered, and the full amount is with you. Nothing to do.",
    };
  }

  if (status === "RETURNED_UNPAID") {
    return {
      tone: "neutral",
      headline: "Came back, nothing owed",
      sentence:
        "The parcel was returned and no cash was collected, which is the correct outcome for a return. Nobody owes you anything on this one.",
    };
  }

  if (status === "PARTIALLY_COLLECTED") {
    return {
      tone: "held",
      headline: "Part paid",
      sentence: `${money(collected)} has come in so far. ${money(
        expected - collected,
      )} of the ${money(expected)} is still to collect.`,
    };
  }

  if (status === "AWAITING_CONFIRMATION") {
    return {
      tone: "held",
      headline: "Cash in, delivery unconfirmed",
      sentence:
        "The full amount has been collected but the courier has not confirmed the drop-off yet. This normally clears itself.",
    };
  }

  return {
    tone: "neutral",
    headline: "Nothing yet",
    sentence: "The courier has not reported anything on this order so far.",
  };
}

/**
 * The single most useful number on a row: what is actually outstanding, and in
 * which direction. Deliberately NOT `expected - collected` — a returned unpaid
 * parcel has a large arithmetic gap and owes nobody anything, and a returned
 * parcel that WAS paid for owes you the cash the courier is holding, which is
 * the collected amount rather than the difference.
 */
function differenceOf(order) {
  const status = order.reconciliation_status;
  const expected = Number(order.cod_amount ?? 0);
  const collected = Number(order.amount_collected ?? 0);

  if (order.discrepancy_reason === "RETURNED_WITH_PAYMENT") {
    return { amount: collected, word: "to recover", tone: "flag" };
  }
  if (collected > expected) {
    return { amount: collected - expected, word: "overpaid", tone: "flag" };
  }
  if (status === "RETURNED_UNPAID" || status === "PENDING" || collected === expected) {
    return null;
  }
  if (isFlagged(status)) {
    return { amount: expected - collected, word: "short", tone: "flag" };
  }
  if (status === "PARTIALLY_COLLECTED") {
    return { amount: expected - collected, word: "still to collect", tone: "held" };
  }
  return null;
}

/**
 * THE SIGNATURE. Collected and expected on ONE shared scale, so the expected
 * line sits where the obligation ends and an overpayment physically overshoots
 * it. The ledger never clamps at cod_amount; neither does its picture — the
 * stretch past the line is hatched so it reads as "gone past", not as "more".
 */
function reconciliationBar(order) {
  const expected = Number(order.cod_amount ?? 0);
  const collected = Number(order.amount_collected ?? 0);
  const scale = Math.max(expected, collected, 1);
  const collectedPct = (collected / scale) * 100;
  const expectedPct = (expected / scale) * 100;

  const over =
    collected > expected ? `<div class="recbar__over"></div>` : "";

  return `
    <div class="recbar">
      <p class="recbar__figures">
        <span class="recbar__collected">${escapeHtml(money(collected))}</span>
        <span class="recbar__expected-text">collected of ${escapeHtml(
          money(expected),
        )} expected</span>
      </p>
      <div class="recbar__track" role="img"
           aria-label="${escapeHtml(money(collected))} collected against ${escapeHtml(
             money(expected),
           )} expected"
           style="--collected-pct:${collectedPct};--expected-pct:${expectedPct};--bar-color:${barColor(
             order.reconciliation_status,
           )}">
        <div class="recbar__clip">
          <div class="recbar__fill"></div>
          ${over}
        </div>
        <div class="recbar__expected"></div>
      </div>
    </div>`;
}

/** The difference column: right-aligned, large, and the row's headline number. */
function differenceCell(order) {
  const difference = differenceOf(order);
  if (difference === null) {
    return `<td class="diff"><span class="diff__none" title="Nothing outstanding on this order">&mdash;</span></td>`;
  }
  return `
    <td class="diff" data-tone="${difference.tone}">
      <span class="diff__amount">${escapeHtml(money(difference.amount))}</span>
      <span class="diff__word">${escapeHtml(difference.word)}</span>
    </td>`;
}

/** The "what this means" cell: plain headline, plain sentence, then the enum. */
function meansCell(order) {
  const verdict = plainVerdict(order);
  return `
    <td>
      <div class="means" data-tone="${verdict.tone}">
        <p class="means__headline">${
          verdict.tone === "flag" ? '<span class="flagmark">&#9873;</span>' : ""
        }${escapeHtml(verdict.headline)}</p>
        <p class="means__sentence">${escapeHtml(verdict.sentence)}</p>
        <p class="means__sys" title="The system's own labels for this row.">${escapeHtml(
          `${order.current_status} · ${order.reconciliation_status}`,
        )}</p>
      </div>
    </td>`;
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

/**
 * The one-second answer.
 *
 * Four numbers, but NOT four equal numbers. "Needs a call" gets twice the width
 * and the only red on the page, and it carries both halves of the question a
 * merchant actually has: how many orders, and how much money. The money at
 * stake is the sum of the red amounts in the Difference column below, so the
 * band and the table are the same claim at two levels of detail.
 */
function renderSummary(orders) {
  const expected = orders.reduce((sum, o) => sum + Number(o.cod_amount ?? 0), 0);
  const collected = orders.reduce((sum, o) => sum + Number(o.amount_collected ?? 0), 0);
  const flaggedOrders = orders.filter((o) => isFlagged(o.reconciliation_status));
  const settled = orders.filter((o) => o.reconciliation_status === "FULLY_COLLECTED").length;
  const atStake = flaggedOrders.reduce(
    (sum, o) => sum + (differenceOf(o)?.amount ?? 0),
    0,
  );
  const count = flaggedOrders.length;

  const lead =
    count > 0
      ? `
    <div class="tally tally--lead tally--flagged">
      <p class="tally__label">&#9873; Needs a call</p>
      <p class="tally__value">${count}<span class="tally__stake">${escapeHtml(
        money(atStake),
      )}<small>at stake</small></span></p>
      <p class="tally__note">
        ${count === 1 ? "One order where" : `${count} orders where`} the money and the
        delivery disagree. They are at the top of the list below.
      </p>
    </div>`
      : `
    <div class="tally tally--lead tally--settled-all">
      <p class="tally__label">Needs a call</p>
      <p class="tally__value">0</p>
      <p class="tally__note">
        Nothing to chase. Every order's cash matches what the courier reported.
      </p>
    </div>`;

  $("summary").innerHTML = `
    ${lead}
    <div class="tally">
      <p class="tally__label">Expected</p>
      <p class="tally__value">${escapeHtml(money(expected))}</p>
      <p class="tally__note">across ${orders.length} order${
        orders.length === 1 ? "" : "s"
      }</p>
    </div>
    <div class="tally">
      <p class="tally__label">Collected</p>
      <p class="tally__value">${escapeHtml(money(collected))}</p>
      <p class="tally__note">cash actually reported in</p>
    </div>
    <div class="tally">
      <p class="tally__label">Paid in full</p>
      <p class="tally__value">${settled}</p>
      <p class="tally__note">delivered and settled</p>
    </div>`;
}

function renderOrders(orders) {
  const body = $("orders-body");

  if (orders.length === 0) {
    body.innerHTML = `
      <tr><td colspan="6" class="empty">
        <strong>No orders yet.</strong>
        Book a delivery above, then send it courier events to watch the ledger reconcile.
      </td></tr>`;
    return;
  }

  // Problems first. A merchant opens this page to find the rows that need them,
  // and a stable sort leaves everything else in the order the API returned it.
  const sorted = [...orders].sort(
    (a, b) =>
      Number(isFlagged(b.reconciliation_status)) -
      Number(isFlagged(a.reconciliation_status)),
  );

  body.innerHTML = sorted
    .map((order) => {
      const href = `#/orders/${encodeURIComponent(order.order_id)}`;
      return `
      <tr data-flagged="${isFlagged(order.reconciliation_status)}">
        <td class="cell-order"><a class="order-chip" href="${href}" title="${escapeHtml(
          order.order_id,
        )}">${escapeHtml(shortId(order.order_id))}</a></td>
        <td class="customer"><a href="${href}">${escapeHtml(order.customer_name)}</a></td>
        <td>${reconciliationBar(order)}</td>
        ${differenceCell(order)}
        <td class="cell-delivery">
          <span class="delivery" data-status="${escapeHtml(order.current_status)}">${escapeHtml(
            DELIVERY_PLAIN[order.current_status] ?? words(order.current_status),
          )}</span>
        </td>
        ${meansCell(order)}
      </tr>`;
    })
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

  // The API's own words for where this answer came from, kept verbatim — with a
  // plain explanation attached rather than a translation replacing them.
  const zone = $("dashboard-zone");
  zone.textContent = `${words(data.source)} · ${data.consistency}`;
  zone.title =
    "Where these figures came from. They are read from a copy of the ledger rather than the ledger itself, so a courier's report can take a second or two to appear here. The money is never wrong, only occasionally a moment late.";
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
      <div class="book__head">
        <div>
          <p class="eyebrow">Authoritative</p>
          <h2 class="panel__title">The ledger itself</h2>
          <p class="book__caption">
            The final word on this order's money. Read straight from the ledger, so it
            cannot be out of date.
          </p>
        </div>
        ${badge(
          "durable object · strong",
          "cp",
          "Read directly from the ledger. Whatever it says here is true at this instant — no copy, no lag.",
        )}
      </div>
      <div class="book__figures">
        <div>
          <p class="figure__label">Collected</p>
          <p class="figure__value">${escapeHtml(money(state.amount_collected))}</p>
        </div>
        <div>
          <p class="figure__label">Delivery</p>
          <p class="figure__value figure__value--word">${escapeHtml(
            DELIVERY_PLAIN[state.status] ?? words(state.status),
          )}</p>
          <p class="figure__note">${escapeHtml(state.status)}</p>
        </div>
        <div>
          <p class="figure__label">Version</p>
          <p class="figure__value">${state.version}</p>
          <p class="figure__note">events applied</p>
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
  const outcomeTitle = {
    applied: "The ledger accepted this event and it changed the order.",
    buffered:
      "Held back. It arrived before the event it depends on, and the ledger will retry it automatically.",
    anomaly:
      "The ledger refused this event because it contradicts what already happened. No money moved.",
  };

  return `
    <table class="timeline">
      <thead>
        <tr>
          <th scope="col">What happened</th>
          <th scope="col">Ledger verdict</th>
          <th scope="col" class="th-right">Amount</th>
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
              <span class="event-plain">${escapeHtml(
                EVENT_PLAIN[row.type] ?? words(row.type),
              )}</span>
              ${
                row.delivery_count > 1
                  ? `<span class="repeat" title="The courier sent this ${row.delivery_count} times; it was counted once">×${row.delivery_count}</span>`
                  : ""
              }
              <span class="event-type">${escapeHtml(row.type)}</span>
              <span class="stamp">${escapeHtml(row.event_id)}</span>
            </td>
            <td>${badge(
              OUTCOME_PLAIN[row.outcome] ?? row.outcome,
              tone[row.outcome] ?? "neutral",
              `${outcomeTitle[row.outcome] ?? ""} The ledger's own word for this is "${row.outcome}".`,
            )}</td>
            <td class="money-cell" data-empty="${row.amount === null}">${
              row.amount === null ? "—" : escapeHtml(money(row.amount))
            }</td>
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
  // The customer's name is the heading, because that is what a merchant
  // recognises. The order id is a chip underneath with a copy button — it is
  // for pasting into a courier's spreadsheet, not for reading.
  return `
    <div class="detail-head">
      <h1>${escapeHtml(order.customer_name)}</h1>
      <div class="detail-meta">
        <code class="id-chip" id="full-order-id">${escapeHtml(order.order_id)}</code>
        <button type="button" class="copy-id" id="copy-order-id">Copy id</button>
        <span>Merchant ${escapeHtml(order.merchant_id)}</span>
        <span>Booked ${escapeHtml(clockTime(order.created_at))}</span>
      </div>
    </div>

    <div id="sim-slot"></div>

    <label class="switch" for="compare">
      <input type="checkbox" id="compare" ${compareWithLedger ? "checked" : ""} />
      <span class="switch__text">
        <strong>Check these figures against the ledger itself</strong>
        <span>
          The numbers above come from a copy that can be a second or two behind. Tick this
          to read the ledger directly and see whether the two agree. Technically: the
          Durable Object instead of the D1 projection — it costs a round trip, which is why
          the dashboard never does it and this page only does it when asked.
        </span>
      </span>
    </label>

    <div id="detail-live"></div>`;
}

function detailLive(data) {
  const order = data.order;
  const verdict = plainVerdict(order);
  const difference = differenceOf(order);

  return `
    <!-- The verdict leads. Everything below it is evidence for this sentence. -->
    <div class="verdict" data-tone="${verdict.tone}">
      <p class="verdict__headline">${
        verdict.tone === "flag" ? '<span class="flagmark">&#9873;</span> ' : ""
      }${escapeHtml(verdict.headline)}</p>
      <p class="verdict__sentence">${escapeHtml(verdict.sentence)}</p>
      <p class="verdict__sys" title="The system's own labels for this order.">${escapeHtml(
        `${order.current_status} · ${order.reconciliation_status}${
          order.discrepancy_reason ? ` · ${order.discrepancy_reason}` : ""
        }`,
      )}</p>
    </div>

    ${compareWithLedger ? renderDivergence(data.divergence) : ""}

    <div class="compare">
      <div class="panel book">
        <div class="book__head">
          <div>
            <p class="eyebrow">Projected</p>
            <h2 class="panel__title">The money on this order</h2>
            <p class="book__caption">
              The same figures the dashboard shows, from a copy that catches up within
              seconds of a courier report.
            </p>
          </div>
          ${badge(
            `${words(data.source)} · ${data.consistency}`,
            "neutral",
            "Read from a copy of the ledger rather than the ledger itself, so it can be a second or two behind. Tick the box below to compare it against the ledger directly.",
          )}
        </div>
        <div style="margin-bottom:1.15rem">${reconciliationBar(order)}</div>
        <div class="book__figures">
          <div>
            <p class="figure__label">Expected</p>
            <p class="figure__value">${escapeHtml(money(order.cod_amount))}</p>
            <p class="figure__note">what the courier should collect</p>
          </div>
          <div>
            <p class="figure__label">Collected</p>
            <p class="figure__value">${escapeHtml(money(order.amount_collected))}</p>
            <p class="figure__note">reported in so far</p>
          </div>
          <div>
            <p class="figure__label">Difference</p>
            <p class="figure__value"${
              difference?.tone === "flag" ? ' data-tone="flag"' : ""
            }>${difference === null ? "&mdash;" : escapeHtml(money(difference.amount))}</p>
            <p class="figure__note">${
              difference === null ? "nothing outstanding" : escapeHtml(difference.word)
            }</p>
          </div>
          <div>
            <p class="figure__label">Delivery</p>
            <p class="figure__value figure__value--word">${escapeHtml(
              DELIVERY_PLAIN[order.current_status] ?? words(order.current_status),
            )}</p>
            <p class="figure__note">${escapeHtml(order.current_status)}</p>
          </div>
        </div>
      </div>

      ${compareWithLedger ? renderLedgerBook(data.authoritative) : ""}
    </div>

    ${compareWithLedger ? renderHeldEvents(data.authoritative?.pending) : ""}

    <section class="panel panel--sheet">
      <div class="panel__head">
        <div>
          <p class="eyebrow">Timeline</p>
          <h2 class="panel__title">Everything the courier reported</h2>
          <p class="panel__lede">
            And what the ledger did with each report. This is the record you read out
            when you call the courier.
          </p>
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

    // The id is here to be pasted into a courier's spreadsheet, so the button
    // says what it did rather than leaving the merchant guessing.
    $("copy-order-id").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      try {
        await navigator.clipboard.writeText(orderId);
        button.textContent = "Copied";
      } catch {
        // Clipboard access can be refused; selecting the text still works.
        button.textContent = "Press Ctrl+C";
        const range = document.createRange();
        range.selectNodeContents($("full-order-id"));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setTimeout(() => (button.textContent = "Copy id"), 1800);
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
