/**
 * The courier simulator — Phase 6.
 *
 * THE POINT, and the reason this is not a "fake event" button: every one of
 * these controls makes a real authenticated `POST /webhook/courier` from the
 * browser, over the network, cross-origin. It is an external event source that
 * the system does not control the ordering of, because it genuinely is one —
 * nothing here reaches inside the Worker to inject a message, and nothing skips
 * the queue. The scenarios below are exactly what a real courier integration
 * would do to us, on a bad day, and the ledger has to survive them the same way.
 *
 * The two scenarios that matter are the ones the whole design exists for:
 *
 *   DUPLICATE     the same event_id twice. A courier whose webhook call timed
 *                 out retries it; the payment must be counted ONCE.
 *   OUT OF ORDER  `returned` before `delivery_attempted`. Note the timestamps:
 *                 events are stamped as they fire, so the one sent first carries
 *                 the EARLIER `occurred_at` — which is precisely the case that
 *                 used to fail the staleness rule on drain (Decision 11).
 *
 * A note on the secret. This panel holds the courier bearer token in the
 * browser, which no production integration would ever do — a shared secret in
 * client-side JavaScript is not a secret. It is acceptable here for one reason:
 * this simulator stands in for the courier's own server, and it is a development
 * tool that is not deployed with a real credential. Said plainly in the UI, not
 * buried here.
 */

(function () {
  const DEFAULT_SECRET = "dev-courier-secret-change-me";
  const SECRET_STORAGE_KEY = "cod.courier.secret";
  const POISON_COURIER_ID = "sim-poison";

  let context = null;
  let running = false;
  const log = [];

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function readSecret() {
    try {
      return localStorage.getItem(SECRET_STORAGE_KEY) ?? DEFAULT_SECRET;
    } catch {
      return DEFAULT_SECRET;
    }
  }

  function storeSecret(value) {
    try {
      localStorage.setItem(SECRET_STORAGE_KEY, value);
    } catch {
      /* Private windows refuse storage; the field still works for this session. */
    }
  }

  function newEventId(label) {
    const random = Math.random().toString(36).slice(2, 8);
    return `evt_${label}_${Date.now().toString(36)}_${random}`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );
  }

  function note(message, tone = "step") {
    log.unshift({ at: new Date(), message, tone });
    if (log.length > 40) log.length = 40;
    paintLog();
  }

  function paintLog() {
    const target = document.getElementById("sim-log");
    if (target === null) return;

    target.innerHTML =
      log.length === 0
        ? `<li class="sim-log__empty">Nothing sent yet. Pick a scenario above.</li>`
        : log
            .map(
              (entry) => `
        <li data-tone="${entry.tone}">
          <span class="sim-log__time">${entry.at.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}</span>
          <span>${escapeHtml(entry.message)}</span>
        </li>`,
            )
            .join("");
  }

  function setBusy(isBusy) {
    running = isBusy;
    const panel = document.getElementById("sim-panel");
    if (panel === null) return;
    panel.dataset.busy = String(isBusy);
    panel.querySelectorAll("button").forEach((button) => (button.disabled = isBusy));
  }

  /**
   * One real courier event, over the wire. Returns the webhook's verdict rather
   * than throwing on a 4xx: a rejected event is a legitimate demo outcome (try
   * the custom form with a negative amount) and the log should show it.
   */
  async function send(event, label) {
    const body = {
      schema_version: 1,
      courier_id: "sim-courier-1",
      order_id: context.orderId,
      event_id: newEventId(label ?? event.type),
      // Stamped as it fires. Deliberate: this is what makes the out-of-order
      // scenario carry a genuinely earlier timestamp on the event sent first.
      occurred_at: new Date().toISOString(),
      ...event,
    };

    let response;
    try {
      response = await fetch(`${context.api}/webhook/courier`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${readSecret()}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      note("Could not reach the webhook — is the Worker running?", "bad");
      return null;
    }

    if (response.status === 202) {
      note(
        `sent ${body.type}${body.amount ? ` ${body.amount}` : ""} → 202 accepted, queued`,
        "good",
      );
    } else if (response.status === 401) {
      note("401 unauthorized — the courier secret below does not match the Worker's", "bad");
    } else {
      const detail = await response.json().catch(() => null);
      note(
        `${body.type} → ${response.status} ${detail?.error ?? ""} ${
          detail?.details?.[0]?.message ?? ""
        }`.trim(),
        "bad",
      );
    }

    context.onSent();
    return { status: response.status, body };
  }

  /** A visible pause, so a transient state can actually be seen. */
  async function pause(seconds, why) {
    note(`waiting ${seconds}s — ${why}`, "wait");
    await wait(seconds * 1000);
    context.onSent();
  }

  /** Money accrues only from DISPATCHED, so most scenarios need this first. */
  async function ensureDispatched() {
    const order = context.getOrder();
    if (order?.current_status !== "PENDING") return true;

    await send({ type: "delivery_attempted" }, "dispatch");
    await pause(3, "letting the queue deliver it before the next event");
    return true;
  }

  // -------------------------------------------------------------------------
  // Scenarios
  // -------------------------------------------------------------------------

  async function run(scenario) {
    if (running) return;
    setBusy(true);
    try {
      await scenario();
    } catch (error) {
      note(`scenario stopped: ${error.message}`, "bad");
    } finally {
      setBusy(false);
    }
  }

  async function happyPath() {
    const order = context.getOrder();
    note("Happy path: dispatched, paid in full, delivered.");
    await ensureDispatched();
    await send({ type: "payment_collected", amount: order.cod_amount }, "pay");
    await pause(3, "letting the payment land before confirming delivery");
    await send({ type: "delivery_confirmed" }, "confirm");
    note("Expect FULLY_COLLECTED once the projection catches up.", "good");
  }

  async function duplicatePayment() {
    const order = context.getOrder();
    note("Duplicate: the SAME event_id sent twice, as a retrying courier would.");
    await ensureDispatched();

    // One id, sent twice. This is the whole scenario — the second delivery must
    // move no money.
    const eventId = newEventId("dup_pay");
    await send(
      { type: "payment_collected", amount: order.cod_amount, event_id: eventId },
      "dup_pay",
    );
    await pause(4, "letting the first delivery be applied");

    note("Sending the identical event again — same event_id, same amount.");
    await send(
      { type: "payment_collected", amount: order.cod_amount, event_id: eventId },
      "dup_pay",
    );

    note(
      `Expect collected to stay at ${order.cod_amount}, and the timeline row to read ×2.`,
      "good",
    );
  }

  async function outOfOrder() {
    const order = context.getOrder();
    if (order?.current_status !== "PENDING") {
      note("This scenario needs an order still PENDING. Create a fresh one.", "bad");
      return;
    }

    note("Out of order: `returned` arrives BEFORE `delivery_attempted`.");
    await send({ type: "returned" }, "ooo_returned");
    await pause(5, "watch the timeline: it should read `buffered`, and money is untouched");

    note("Now the event it was waiting for, stamped LATER than the returned.");
    await send({ type: "delivery_attempted" }, "ooo_dispatch");

    note(
      "Expect the buffer to drain and the verdict to flip buffered → applied: RETURNED_UNPAID.",
      "good",
    );
  }

  async function partialPayment() {
    const order = context.getOrder();
    const amount = Math.max(1, Math.floor(order.cod_amount * 0.4));
    note(`Partial payment: ${amount} of ${order.cod_amount}.`);
    await ensureDispatched();
    await send({ type: "partial_payment", amount }, "partial");
    note("Expect PARTIALLY_COLLECTED, with the bar short of the expected line.", "good");
  }

  async function poison() {
    note("Poison: a well-formed event the consumer fails on every single time.");
    await send({ type: "payment_collected", amount: 1, courier_id: POISON_COURIER_ID }, "poison");
    note("It will be retried 5 times, then moved to courier-events-dlq.", "wait");
    note("Takes ~35s. Watch the dead-letter panel on the dashboard.", "wait");
  }

  async function customEvent() {
    const type = document.getElementById("sim-type").value;
    const rawAmount = document.getElementById("sim-amount").value.trim();
    const rawWhen = document.getElementById("sim-when").value;

    const event = { type };
    if (rawAmount !== "") event.amount = Number(rawAmount);
    // datetime-local has no timezone; the API wants ISO 8601 UTC.
    if (rawWhen !== "") event.occurred_at = new Date(rawWhen).toISOString();

    note(`Custom: ${type}${event.amount ? ` for ${event.amount}` : ""}.`);
    await send(event, "custom");
  }

  // -------------------------------------------------------------------------
  // Mounting
  // -------------------------------------------------------------------------

  const SCENARIOS = {
    "sim-happy": happyPath,
    "sim-duplicate": duplicatePayment,
    "sim-ooo": outOfOrder,
    "sim-partial": partialPayment,
    "sim-poison": poison,
    "sim-custom": customEvent,
  };

  function template(eventTypes) {
    return `
      <section class="panel sim" id="sim-panel">
        <div class="panel__head">
          <div>
            <p class="eyebrow">Simulator</p>
            <h2 class="panel__title">Drive the courier</h2>
          </div>
          <p class="zone">posts to /webhook/courier</p>
        </div>

        <div class="sim__body">
          <p class="panel__lede">
            Every button below makes a real, authenticated POST to the courier webhook — the
            same request a courier's server would make. Nothing is injected internally, and
            nothing skips the queue.
          </p>

          <div class="sim__buttons">
            <button class="button button--scenario" id="sim-happy" type="button">
              Happy path
              <span>dispatched → paid → delivered</span>
            </button>
            <button class="button button--scenario" id="sim-duplicate" type="button">
              Send payment twice
              <span>same event_id — money must move once</span>
            </button>
            <button class="button button--scenario" id="sim-ooo" type="button">
              Returned before dispatch
              <span>arrives early — buffers, then converges</span>
            </button>
            <button class="button button--scenario" id="sim-partial" type="button">
              Partial payment
              <span>40% collected, rest outstanding</span>
            </button>
          </div>

          <details class="sim__custom">
            <summary>Custom event</summary>
            <div class="sim__custom-grid">
              <label>
                <span>Type</span>
                <select id="sim-type">
                  ${eventTypes.map((type) => `<option value="${type}">${type}</option>`).join("")}
                </select>
              </label>
              <label>
                <span>Amount</span>
                <input id="sim-amount" type="number" min="1" step="1" placeholder="optional" />
              </label>
              <label>
                <span>Occurred at</span>
                <input id="sim-when" type="datetime-local" />
              </label>
              <button class="button" id="sim-custom" type="button">Send event</button>
            </div>
          </details>

          <details class="sim__secret">
            <summary>Courier credentials</summary>
            <label>
              <span>Bearer token sent with every event</span>
              <input id="sim-secret" type="text" value="${escapeHtml(readSecret())}" />
            </label>
            <p>
              A real courier integration would never hold this in a browser — a shared secret in
              client-side JavaScript is not a secret. This panel stands in for the courier's own
              server and is a development tool, not something deployed with a live credential.
            </p>
          </details>

          <div class="sim__dlq">
            <p class="eyebrow">Dead-letter queue</p>
            <button class="button button--danger" id="sim-poison" type="button">
              Send a poison event
            </button>
            <p>
              Well-formed, and the consumer throws on it every time. After 5 retries Queues moves
              it to <code>courier-events-dlq</code>, where a second consumer records it — proving
              one bad message cannot block the pipeline. Takes about 35 seconds.
              <strong>Shown here in local emulation; the production hand-off is unverified.</strong>
            </p>
          </div>

          <ol class="sim-log" id="sim-log"></ol>
        </div>
      </section>`;
  }

  function mount(slot, ctx) {
    context = ctx;
    log.length = 0;

    const eventTypes = window.__vocabulary?.event_types ?? [
      "delivery_attempted",
      "payment_collected",
      "partial_payment",
      "delivery_confirmed",
      "returned",
    ];

    slot.innerHTML = template(eventTypes);

    for (const [id, scenario] of Object.entries(SCENARIOS)) {
      document.getElementById(id).addEventListener("click", () => run(scenario));
    }

    document.getElementById("sim-secret").addEventListener("change", (event) => {
      storeSecret(event.target.value.trim());
      note("Courier token updated for this browser.");
    });

    paintLog();
  }

  window.Simulator = { mount };
})();
