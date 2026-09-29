/* ============================================================================
 * Runinback — console wallet: balance, rcoin purchase, withdrawals, activity.
 *
 * The 5% commission is charged once, on the way in (buying rcoin), and shown
 * as a clear rate. Withdrawals are 1:1 with no exit fee. The balance is only
 * ever credited server-side: by the verified Stripe / Coinbase webhooks, or by
 * the test RPC while the platform is in test mode.
 * ========================================================================== */
import { config } from "../lib/config.js";
import { replayClass, tweenNumber } from "../lib/motion.js";
import { byId as $, escapeHtml as esc, showMessage } from "../lib/dom.js";
import {
  centsToRcoin, formatDate, formatRcoin, formatUsd, parseDollarsToCents, parseRcoinToCents, quotePurchase,
} from "../lib/format.js";
import { functionError } from "../lib/errors.js";
import { errorText, session } from "./context.js";

const MIN_PURCHASE_CENTS = 100;
const MAX_PURCHASE_CENTS = 200000;
const MIN_WITHDRAW_CENTS = 100;

const PAY_NOTES = {
  card: "Secure card checkout via Stripe.",
  crypto: "Pay in USDC/USDT on Base and other chains via Coinbase.",
};

// Which real payment rails are live. When more than one is on, the buyer picks
// between them; when just one, it's used silently; when none, the test RPC.
let payMethod = config.stripeEnabled ? "card" : (config.cryptoEnabled ? "crypto" : null);

function setText(id, text) {
  const node = $(id);
  if (node) node.textContent = text;
}

export function refreshWallet() {
  return session.client.from("wallets").select("test_balance_cents, test_locked_cents").eq("user_id", session.uid).single()
    .then(function (r) {
      // Never show a made-up zero: on failure keep the last known balance.
      if (r.error || !r.data) {
        if (session.balanceCents == null) { setText("wallet-chip", "— rcoin"); $("wallet-chip").setAttribute("aria-label", "Balance unavailable. Open wallet"); }
        return null;
      }
      const w = r.data;
      const previous = session.balanceCents;
      session.balanceCents = w.test_balance_cents;
      document.dispatchEvent(new CustomEvent("rib:balance", { detail: w.test_balance_cents }));
      $("wallet-chip").setAttribute("aria-label", "Balance " + formatRcoin(w.test_balance_cents) + ". Open wallet");
      // A changed balance counts to its new value (and the chip bumps once) so
      // a win, a refund or a purchase is noticed; the first load just renders.
      const from = previous == null ? w.test_balance_cents : previous;
      tweenNumber($("wallet-chip"), from, w.test_balance_cents, function (v) {
        const cents = Math.round(v);
        setText("wallet-chip", formatRcoin(cents));
        if ($("games-balance")) $("games-balance").innerHTML = centsToRcoin(cents) + " <small>rcoin</small>";
        setText("wallet-balance", formatRcoin(cents));
        setText("wallet-usd", formatUsd(cents));
        setText("dev-balance", formatRcoin(cents));
      });
      if (previous != null && previous !== w.test_balance_cents) replayClass($("wallet-chip"), "is-bumped");
      setText("wallet-locked", "In play: " + formatRcoin(w.test_locked_cents));
      return w;
    })
    .catch(function () { return null; });
}

export function loadLedger() {
  session.client.from("wallet_ledger")
    .select("kind, amount_cents, balance_after_cents, memo, created_at")
    .order("created_at", { ascending: false })
    .limit(40)
    .then(function (r) {
      const box = $("wallet-ledger");
      const rows = r.data || [];
      if (r.error) { box.innerHTML = '<p class="muted">Couldn\'t load your activity.</p>'; return; }
      if (!rows.length) { box.innerHTML = '<div class="empty"><h3>No activity yet</h3><p>Buy some rcoin to get started.</p></div>'; return; }
      box.innerHTML = '<div class="panel">' + rows.map(function (m) {
        const positive = m.amount_cents >= 0;
        return '<div class="row row--led"><div><div class="row__name">' + esc(m.memo || m.kind) +
          '</div><div class="row__meta">' + formatDate(m.created_at) + "</div></div>" +
          '<span class="amt ' + (positive ? "pos" : "neg") + '">' + (positive ? "+" : "") + formatRcoin(m.amount_cents) + "</span></div>";
      }).join("") + "</div>";
    });
}

export function updatePurchaseQuote() {
  const pay = parseDollarsToCents($("buy-amount").value);
  const quote = quotePurchase(pay);
  const receive = centsToRcoin(quote.receiveCents);
  const tooLow = !isFinite(pay) || pay < MIN_PURCHASE_CENTS;
  setText("buy-pay", formatUsd(quote.payCents));
  setText("buy-fee", formatUsd(quote.feeCents));
  setText("buy-receive", receive + " rcoin");
  // Say why the button is disabled instead of offering "Buy 0 rcoin".
  setText("buy-submit", tooLow ? "Enter at least $1" : "Buy " + receive + " rcoin");
  $("buy-submit").disabled = tooLow || quote.receiveCents <= 0;
}

function updateWithdrawQuote() {
  let amount = parseFloat(String($("withdraw-amount").value).replace(",", "."));
  if (!isFinite(amount) || amount < 0) amount = 0;
  // Whole rcoin only (the server rounds), paid out 1:1.
  setText("withdraw-receive", "$" + Math.round(amount).toFixed(2));
}

function setPayMethod(method) {
  payMethod = method;
  document.querySelectorAll('[data-chips="pay-method"] button').forEach(function (x) {
    x.classList.toggle("on", x.getAttribute("data-method") === method);
  });
  setText("pay-note", PAY_NOTES[method] || "");
}

function initPayMethod() {
  const wrap = $("pay-method");
  if (!wrap) return;
  // Show the chooser only when both rails are live (a real choice to make).
  if (config.stripeEnabled && config.cryptoEnabled) {
    wrap.hidden = false;
    document.querySelectorAll('[data-chips="pay-method"] button').forEach(function (btn) {
      btn.addEventListener("click", function () { setPayMethod(btn.getAttribute("data-method")); });
    });
    setPayMethod("card");
  } else {
    wrap.hidden = true; // single rail (or test mode) — no selector needed
  }
}

// Start a hosted checkout (Stripe or Coinbase Commerce). The balance is
// credited only by the verified webhook after payment, never in the browser.
function startCheckout(functionName, payCents, btn) {
  showMessage($("wallet-msg"), "Redirecting to secure checkout…", true);
  session.client.functions.invoke(functionName, { body: { pay_cents: payCents } })
    .then(function (r) {
      if (r.error || !r.data || !r.data.url) {
        btn.disabled = false;
        return functionError(r.error).then(function (err) {
          showMessage($("wallet-msg"), errorText(err, "Couldn't start checkout. Try again in a moment."), false);
        });
      }
      window.location.href = r.data.url;
    })
    .catch(function () { showMessage($("wallet-msg"), "Network error.", false); btn.disabled = false; });
}

function withdraw(amountInput, msgNode, btn, onDone) {
  const text = String(amountInput.value).trim();
  if (!/^\d+$/.test(text)) { showMessage(msgNode, "Enter whole rcoin, no decimals.", false); return; }
  const amount = parseRcoinToCents(text);
  if (amount < MIN_WITHDRAW_CENTS) { showMessage(msgNode, "Minimum 1 rcoin.", false); return; }
  if (session.balanceCents != null && amount > session.balanceCents) {
    showMessage(msgNode, "You have " + formatRcoin(session.balanceCents) + " available.", false);
    return;
  }
  btn.disabled = true;
  session.client.rpc("rib_withdraw_test", { p_amount_cents: amount })
    .then(function (r) {
      if (r.error) { showMessage(msgNode, errorText(r.error, "Couldn't withdraw."), false); return; }
      showMessage(msgNode, "Withdrawal complete.", true);
      amountInput.value = "";
      onDone();
    })
    .catch(function () { showMessage(msgNode, "Network error.", false); })
    .finally(function () { btn.disabled = false; });
}

export function initWallet() {
  if (!$("buy-submit")) return;
  // Coming back from a hosted checkout via the back button restores this page
  // from the bfcache with the buy button still disabled.
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) { $("buy-submit").disabled = false; $("wallet-msg").hidden = true; }
  });
  $("buy-amount").addEventListener("input", function () {
    document.querySelectorAll('[data-chips="buy-amount"] button').forEach(function (x) { x.classList.remove("on"); });
    updatePurchaseQuote();
  });
  $("withdraw-amount").addEventListener("input", updateWithdrawQuote);
  $("withdraw-destination").addEventListener("change", updateWithdrawQuote);
  initPayMethod();
  updatePurchaseQuote();
  updateWithdrawQuote();

  $("buy-submit").addEventListener("click", function () {
    const pay = parseDollarsToCents($("buy-amount").value);
    if (!isFinite(pay) || pay < MIN_PURCHASE_CENTS) { showMessage($("wallet-msg"), "Minimum $1.", false); return; }
    if (pay > MAX_PURCHASE_CENTS) { showMessage($("wallet-msg"), "Maximum $2000 per purchase.", false); return; }
    const btn = $("buy-submit");
    btn.disabled = true;

    if (payMethod === "card") { startCheckout("stripe-checkout", pay, btn); return; }
    if (payMethod === "crypto") { startCheckout("crypto-checkout", pay, btn); return; }

    // Test path (no payment rails yet): instant credit via the test RPC.
    session.client.rpc("rib_buy_rcoin_test", { p_pay_cents: pay })
      .then(function (r) {
        if (r.error) { showMessage($("wallet-msg"), errorText(r.error, "Couldn't complete the purchase."), false); return; }
        showMessage($("wallet-msg"), "Purchase complete.", true);
        refreshWallet();
        loadLedger();
      })
      .catch(function () { showMessage($("wallet-msg"), "Network error.", false); })
      .finally(function () { btn.disabled = false; updatePurchaseQuote(); });
  });

  $("withdraw-submit").addEventListener("click", function () {
    withdraw($("withdraw-amount"), $("wallet-msg"), $("withdraw-submit"), function () {
      updateWithdrawQuote();
      refreshWallet();
      loadLedger();
    });
  });

  $("dev-withdraw-submit").addEventListener("click", function () {
    withdraw($("dev-withdraw-amount"), $("dev-withdraw-msg"), $("dev-withdraw-submit"), refreshWallet);
  });
}

/**
 * Stripe / Coinbase send the buyer back to console.html?checkout=success|cancel.
 * The balance is credited asynchronously by the webhook, so on success we open
 * the wallet and refresh a few times to catch the credit as it lands.
 */
export function handleCheckoutReturn(goToPage) {
  let params;
  try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
  const result = params.get("checkout");
  if (!result) return;
  // Clean the query string so a refresh doesn't re-trigger the banner.
  try { window.history.replaceState({}, "", window.location.pathname); } catch (e) { /* ignore */ }
  if (result === "success") {
    goToPage("page-wallet");
    showMessage($("wallet-msg"), "Payment received. Your rcoin will appear here in a few seconds.", true);
    let tries = 0;
    const poll = setInterval(function () {
      tries++;
      refreshWallet();
      loadLedger();
      if (tries >= 5) {
        clearInterval(poll);
        showMessage($("wallet-msg"), "Still processing. Card payments usually land within a minute and crypto can take a few more; your activity updates as soon as it does.", true);
      }
    }, 2000);
  } else if (result === "cancel") {
    goToPage("page-wallet");
    showMessage($("wallet-msg"), "Checkout cancelled. No charge was made.", false);
  }
}
