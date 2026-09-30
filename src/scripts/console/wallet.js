/* ============================================================================
 * Runinback — console wallet: balance, rcoin purchase, withdrawals, activity.
 *
 * The 5% commission is charged once, on the way in (buying rcoin by card),
 * and shown as a clear rate. Withdrawals are 1:1 with no exit fee. The
 * balance is only ever credited server-side: by the verified Stripe webhook,
 * or by the test RPC while the platform is in test mode.
 * ========================================================================== */
import { config } from "../lib/config.js";
import { prefersReducedMotion, replayClass, tweenNumber } from "../lib/motion.js";
import { byId as $, escapeHtml as esc, showMessage } from "../lib/dom.js";
import {
  centsToRcoin, formatDate, formatRcoin, formatUsd, parseDollarsToCents, parseRcoinToCents, quotePurchase,
} from "../lib/format.js";
import { functionError, toast } from "../lib/errors.js";
import { playReturn } from "../lib/wild-rift.js";
import { errorText, session } from "./context.js";
import { goToPage } from "./navigation.js";
import { peakArt } from "./art.js";

const MIN_PURCHASE_CENTS = 100;
const MAX_PURCHASE_CENTS = 200000;
const MIN_WITHDRAW_CENTS = 100;

// Card checkout (Stripe) when it's live; otherwise the test RPC credits at once.
const CARD_CHECKOUT = config.stripeEnabled;

function setText(id, text) {
  const node = $(id);
  if (node) node.textContent = text;
}

// What's committed but not spendable: entry fees in tournaments I'm still
// playing (they sit in the prize pool) and deposits held on disputes.
let inTournamentsCents = 0;
function renderCommitted() {
  const el = $("wallet-locked");
  if (!el) return;
  const parts = [];
  if (inTournamentsCents > 0) parts.push("In tournaments: " + formatRcoin(inTournamentsCents));
  if (session.lockedCents > 0) parts.push("Held: " + formatRcoin(session.lockedCents));
  el.textContent = parts.join(" · ");
  el.hidden = parts.length === 0;
}

function loadCommitted() {
  return session.client.rpc("rib_my_tournaments", { p_limit: 60 }).then(function (r) {
    const rows = Array.isArray(r && r.data) ? r.data : [];
    inTournamentsCents = rows.reduce(function (sum, t) {
      const playing = t.status === "open" || (t.status === "active" && !t.eliminated);
      return sum + (playing ? Number(t.entry_fee_cents) || 0 : 0);
    }, 0);
    renderCommitted();
  }).catch(function () { /* the line just stays as it was */ });
}

// A balance that went up (a prize, a refund, a purchase) says by how much:
// a small "+25.2" rises from the chip and fades. Decorative; the chip's
// label carries the new balance.
function floatDelta(deltaCents) {
  const chip = $("wallet-chip");
  if (!chip || deltaCents <= 0 || prefersReducedMotion() || typeof chip.getBoundingClientRect !== "function") return;
  const tag = document.createElement("span");
  tag.className = "wallet-delta";
  tag.setAttribute("aria-hidden", "true");
  tag.textContent = "+" + centsToRcoin(deltaCents);
  chip.parentNode.insertBefore(tag, chip);
  tag.addEventListener("animationend", function () { tag.remove(); }, { once: true });
  setTimeout(function () { if (tag.isConnected) tag.remove(); }, 2000);
}

// The wallet's big number counts up from zero the first time the page shows
// in a session; later visits show it as is.
let heroCounted = false;
let heroCounting = false;
export function countUpBalance() {
  const hero = $("wallet-balance");
  if (!hero || heroCounted || session.balanceCents == null) return;
  heroCounted = true;
  const to = session.balanceCents;
  heroCounting = true;
  tweenNumber(hero, 0, to, function (v) {
    hero.textContent = formatRcoin(Math.round(v));
    if (Math.round(v) === to) heroCounting = false;
  }, 700);
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
        if (!heroCounting) setText("wallet-balance", formatRcoin(cents));
        setText("wallet-usd", formatUsd(cents));
      });
      if (previous != null && previous !== w.test_balance_cents) {
        replayClass($("wallet-chip"), "is-bumped");
        floatDelta(w.test_balance_cents - previous);
      }
      session.lockedCents = w.test_locked_cents || 0;
      renderCommitted();
      return w;
    })
    .catch(function () { return null; });
}

// Ledger rows take the color of what moved: prizes pink, entry fees and
// deposits orange, purchases and refunds green, withdrawals neutral.
function ledgerKind(kind) {
  const k = String(kind || "").toLowerCase();
  if (/prize|win|payout/.test(k)) return "prize";
  if (/entry|fee|deposit|hold|lock/.test(k)) return "entry";
  if (/refund|return|release/.test(k)) return "refund";
  if (/buy|purchase|top/.test(k)) return "buy";
  if (/withdraw/.test(k)) return "out";
  return "other";
}

export function loadLedger() {
  loadCommitted();
  session.client.from("wallet_ledger")
    .select("kind, amount_cents, balance_after_cents, memo, created_at")
    .order("created_at", { ascending: false })
    .limit(40)
    .then(function (r) {
      const box = $("wallet-ledger");
      const rows = r.data || [];
      box.setAttribute("aria-busy", "false");
      if (r.error) { box.innerHTML = '<p class="muted">Couldn\'t load your activity.</p>'; return; }
      if (!rows.length) {
        box.innerHTML = session.balanceCents > 0
          ? '<div class="empty">' + peakArt("escrow") + '<h3>No activity yet</h3><p>You have ' + esc(formatRcoin(session.balanceCents)) + '. Pick a tier on Play to put it to work.</p><p><button type="button" class="btn btn--cta btn--sm" data-go-compete>Go to Play</button></p></div>'
          : '<div class="empty">' + peakArt("escrow") + '<h3>No activity yet</h3><p>Buy rcoin above, then pick an entry fee on Play. Free tiers need no rcoin at all.</p><p><button type="button" class="btn btn--sm" data-focus-buy>Buy rcoin</button></p></div>';
        return;
      }
      box.innerHTML = '<div class="panel">' + rows.map(function (m) {
        const positive = m.amount_cents >= 0;
        return '<div class="row row--led" data-kind="' + esc(ledgerKind(m.kind)) + '"><span class="led__dot" aria-hidden="true"></span><div><div class="row__name">' + esc(m.memo || m.kind) +
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

// Start the hosted Stripe checkout. The balance is credited only by the
// verified webhook after payment, never in the browser.
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

// Came from "Add rcoin to join": prefill what's missing, offer the way back.
let returnTo = null;

/** Prefill a top-up (route arg "buy/<missing cents>/<way back to Play>"). */
export function prepareTopUp(arg) {
  const parts = String(arg || "").split("/");
  if (parts[0] !== "buy") return;
  const missing = parseInt(parts[1], 10) || 0;
  // Gross up for the 5% purchase fee so the credit covers the entry fee.
  const dollars = Math.max(1, Math.ceil(missing / 0.95 / 100));
  $("buy-amount").value = String(dollars);
  document.querySelectorAll('[data-chips="buy-amount"] button').forEach(function (x) { x.classList.remove("on"); });
  updatePurchaseQuote();
  returnTo = playReturn(parts.slice(2).join("/"));
  showMessage($("wallet-msg"), "Add at least " + formatRcoin(missing) + " to join. We've filled in the amount.", true);
  $("buy-amount").focus();
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
  setText("pay-note", CARD_CHECKOUT ? "Secure card checkout by Stripe." : "Test mode: the purchase is simulated, no card needed.");
  const ledger = $("wallet-ledger");
  if (ledger) ledger.addEventListener("click", function (e) {
    if (e.target.closest("[data-focus-buy]")) $("buy-amount").focus();
  });
  updatePurchaseQuote();
  updateWithdrawQuote();

  $("buy-submit").addEventListener("click", function () {
    const pay = parseDollarsToCents($("buy-amount").value);
    if (!isFinite(pay) || pay < MIN_PURCHASE_CENTS) { showMessage($("wallet-msg"), "Minimum $1.", false); return; }
    if (pay > MAX_PURCHASE_CENTS) { showMessage($("wallet-msg"), "Maximum $2000 per purchase.", false); return; }
    const btn = $("buy-submit");
    btn.disabled = true;

    if (CARD_CHECKOUT) { startCheckout("stripe-checkout", pay, btn); return; }

    // Test path (no payment rails yet): instant credit via the test RPC.
    session.client.rpc("rib_buy_rcoin_test", { p_pay_cents: pay })
      .then(function (r) {
        if (r.error) { showMessage($("wallet-msg"), errorText(r.error, "Couldn't complete the purchase."), false); return; }
        showMessage($("wallet-msg"), "Purchase complete.", true);
        refreshWallet();
        loadLedger();
        if (returnTo) {
          const target = returnTo;
          returnTo = null;
          toast("rcoin added. You can join now.", "ok", { label: target.indexOf("q/") === 0 ? "Join now" : "Back to the tournament", onClick: function () { goToPage("page-compete", { arg: target }); } });
        }
      })
      .catch(function () { showMessage($("wallet-msg"), "Network error.", false); })
      .finally(function () { btn.disabled = false; updatePurchaseQuote(); });
  });

  $("withdraw-submit").addEventListener("click", function () {
    withdraw($("withdraw-amount"), $("withdraw-msg"), $("withdraw-submit"), function () {
      updateWithdrawQuote();
      refreshWallet();
      loadLedger();
    });
  });

}

/**
 * Stripe sends the buyer back to console.html?checkout=success|cancel.
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
        showMessage($("wallet-msg"), "Still processing. Card payments usually land within a minute; your activity updates as soon as it does.", true);
      }
    }, 2000);
  } else if (result === "cancel") {
    goToPage("page-wallet");
    showMessage($("wallet-msg"), "Checkout cancelled. No charge was made.", false);
  }
}
