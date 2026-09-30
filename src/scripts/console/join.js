/* ============================================================================
 * Runinback — an invite link: #join/<CODE> (docs/hosted-tournaments.md).
 *
 * The preview (rib_tournament_preview) shows the host, the entry fee, the
 * seats and the prize breakdown, and works signed out: a visitor without an
 * account sees the same card with "Sign in to join", and the code is kept in
 * this browser so the console reopens this link right after login.
 *
 * Signed in, Join sends rib_tournament_join_by_code and lands on the
 * tournament's page. What blocks a join is solved in place, as on Play: no
 * Riot ID links it and comes back here, a short balance offers exactly the
 * missing rcoin.
 * ========================================================================== */
import { byId as $, escapeHtml as esc, showMessage } from "../lib/dom.js";
import { formatRcoin } from "../lib/format.js";
import {
  HOST_FEE_PERCENT, PENDING_JOIN_KEY, formatInviteCode, isInviteCode, normalizeInviteCode, normalizePreview, parseInviteInput,
} from "../lib/hosted.js";
import { getClient } from "../lib/supabase-client.js";
import { RIOT_NETWORK } from "../lib/wild-rift.js";
import { peakArt } from "./art.js";
import { confirmAction } from "./confirm.js";
import { errorText, session } from "./context.js";
import { goToPage } from "./navigation.js";
import { loadGameAccounts } from "./profile.js";
import { refreshWallet } from "./wallet.js";

const STATUS_TEXT = {
  open: "Open", full: "Starting", active: "In progress", payout_pending: "Final played",
  disputed: "Appeal in review", finished: "Finished", cancelled: "Cancelled",
};

let request = 0;
let joining = false;

function feeText(cents) { return cents ? formatRcoin(cents) : "Free"; }

function seats(p) {
  let html = '<div class="seats" style="--n:' + p.size + '" role="img" aria-label="' + p.entrants + " of " + p.size + ' seats taken">';
  for (let i = 0; i < p.size; i++) html += '<span class="seat' + (i < p.entrants ? " is-taken" : "") + '"></span>';
  return html + "</div>";
}

function prizeTable(p) {
  if (!p.feeCents) return '<dl class="tprize"><div><dt>Prize</dt><dd>Free tournament, no prize</dd></div></dl>';
  return '<dl class="tprize">' +
    "<div><dt>Prize pool now</dt><dd>" + formatRcoin(p.now.pool) + "</dd></div>" +
    "<div><dt>Winner if it fills (85%)</dt><dd>" + formatRcoin(p.full.winner) + "</dd></div>" +
    "<div><dt>Host commission (" + HOST_FEE_PERCENT + "%)</dt><dd>" + formatRcoin(p.full.host) + "</dd></div>" +
    "<div><dt>Platform (10%)</dt><dd>" + formatRcoin(p.full.platform) + "</dd></div></dl>";
}

function previewCard(p, actions) {
  const need = Math.max(0, p.size - p.entrants);
  return '<article class="tcard join-card is-invite" data-tid="' + esc(p.id) + '">' +
    '<div class="tcard__top"><div>' +
      '<p class="tcard__eyebrow"><span class="chip chip--settle">Hosted</span> ' +
        (p.visibility === "private" ? '<span class="chip">Private</span> ' : "") +
        '<span class="chip' + (p.status === "open" ? " chip--match" : "") + '">' + esc(STATUS_TEXT[p.status] || p.status) + "</span></p>" +
      '<h2 class="tcard__name">' + esc(p.name) + "</h2>" +
      '<div class="row__meta">hosted by ' + (p.host ? "@" + esc(p.host) : "a Runinback player") + "</div></div>" +
      '<div class="tcard__pool"><span class="k">entry</span><span class="v' + (p.feeCents ? "" : " is-free") + '">' + feeText(p.feeCents) + "</span></div></div>" +
    seats(p) +
    '<div class="tcard__mid"><span>' + p.entrants + "/" + p.size + " players" +
      (p.status === "open" ? " · " + (need === 1 ? '<span class="tcard__last">1 seat left</span>' : need + " seats left") : "") + "</span></div>" +
    prizeTable(p) +
    (p.rules ? '<details class="join-rules" open><summary>Rules from the host</summary><p>' + esc(p.rules) + "</p></details>" : "") +
    '<p class="tcard__note">The host posts each match\'s Wild Rift lobby and decides the winners. After the final there\'s a 24-hour window to appeal before prizes are paid.</p>' +
    '<div class="tcard__act">' + actions + "</div>" +
    '<p class="msg" id="join-msg" hidden></p></article>';
}

function codeForm(code, note) {
  return '<div class="empty">' + peakArt("match") + "<h3>" + esc(note.title) + "</h3><p>" + esc(note.text) + "</p>" +
    '<form class="invite-code invite-code--inline" id="join-code-form" novalidate>' +
      '<label for="join-code-input">Invite code</label>' +
      '<div class="invite-code__row"><input id="join-code-input" type="text" maxlength="120" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCDE-FGH23" value="' + esc(code ? formatInviteCode(code) : "") + '" />' +
      '<button type="submit" class="btn btn--sm">Open</button></div></form></div>';
}

function fetchPreview(client, code) {
  return Promise.resolve(client.rpc("rib_tournament_preview", { p_code: code })).then(function (r) {
    if (r.error) return { error: r.error };
    const p = normalizePreview(r.data);
    return p ? { preview: p } : { error: { hint: "invite_invalid" } };
  });
}

/* ---- signed in ---------------------------------------------------------------- */

function memberActions(p, code) {
  if (p.isHost) {
    return '<span class="chip chip--settle">You host this</span><button type="button" class="btn btn--cta btn--sm" data-manage="' + esc(p.id) + '">Manage</button>';
  }
  if (p.joined) {
    return '<span class="chip chip--match">You\'re in</span><button type="button" class="btn btn--cta btn--sm" data-event="' + esc(p.id) + '">View tournament</button>';
  }
  if (p.status !== "open") {
    return '<span class="muted">Registration is closed.</span><button type="button" class="btn btn--sm" data-event="' + esc(p.id) + '">View tournament</button>';
  }
  return '<button type="button" class="btn btn--cta" data-join-code="' + esc(code) + '">Join · ' + feeText(p.feeCents) + "</button>";
}

/** Page loader for #join/<CODE>. */
export function loadJoin(arg) {
  const root = $("join-root");
  const code = parseInviteInput(arg);
  const mine = ++request;
  wire(root);
  if (!code) {
    root.setAttribute("aria-busy", "false");
    root.innerHTML = codeForm(normalizeInviteCode(arg), arg
      ? { title: "That invite code doesn't look right", text: "Invite codes are 10 letters and numbers. Check the link with the host, or type the code." }
      : { title: "Open an invite", text: "Type the code the host shared, or paste the whole link." });
    return Promise.resolve();
  }
  forgetPendingJoin(code);
  root.setAttribute("aria-busy", "true");
  if (!root.querySelector(".join-card")) root.innerHTML = '<div class="skel skel--card" aria-hidden="true"><span class="skel__l" style="width:55%"></span><span class="skel__l" style="width:35%"></span><span class="skel__l skel__l--bar"></span><span class="skel__l skel__l--pill"></span></div>';
  return fetchPreview(session.client, code).then(function (res) {
    if (mine !== request) return;
    root.setAttribute("aria-busy", "false");
    if (res.error) {
      root.innerHTML = codeForm(code, { title: "We couldn't open this invite", text: errorText(res.error, "Couldn't load the tournament. Try again in a moment.") });
      return;
    }
    const p = res.preview;
    $("join-title").textContent = p.name + ".";
    root.innerHTML = previewCard(p, memberActions(p, code));
    root.dataset.fee = String(p.feeCents);
    root.dataset.name = p.name;
  }).catch(function () {
    if (mine !== request) return;
    root.setAttribute("aria-busy", "false");
    root.innerHTML = '<p class="muted">You\'re offline. The invite loads when you reconnect.</p>';
  });
}

function riotLinked() {
  return loadGameAccounts({ cached: true }).then(function (rows) {
    if (!rows) return null;
    return rows.some(function (a) { return a.network === RIOT_NETWORK; });
  }).catch(function () { return null; });
}

function join(code, btn) {
  if (joining) {
    showMessage($("join-msg"), "Working… try again in a moment.", true);
    return Promise.resolve();
  }
  // Held from the first tap (through the Riot ID check and the confirm
  // dialog) until the server answers, so a double tap can't join twice.
  joining = true;
  btn.disabled = true;
  const release = function () {
    joining = false;
    if (btn.isConnected) btn.disabled = false;
  };
  const root = $("join-root");
  const fee = parseInt(root.dataset.fee, 10) || 0;
  const name = root.dataset.name || "this tournament";
  const back = "j/" + code;
  return riotLinked().then(function (linked) {
    if (linked === false) {
      goToPage("page-profile", { arg: "link/" + RIOT_NETWORK + "/" + back });
      return;
    }
    if (fee && session.balanceCents != null && fee > session.balanceCents) {
      goToPage("page-wallet", { arg: "buy/" + (fee - session.balanceCents) + "/" + back });
      return;
    }
    const go = fee
      ? confirmAction({
        title: "Enter " + name + " for " + formatRcoin(fee) + "?",
        body: "The host runs the bracket and decides each match. You can leave for a full refund until it starts.",
        ok: "Pay " + formatRcoin(fee) + " and join",
      })
      : Promise.resolve(true);
    return go.then(function (ok) {
      if (!ok) return;
      return Promise.resolve(session.client.rpc("rib_tournament_join_by_code", { p_code: code })).then(function (r) {
        if (r.error) {
          if (r.error.hint === "riot_account_required") { goToPage("page-profile", { arg: "link/" + RIOT_NETWORK + "/" + back }); return; }
          showMessage($("join-msg"), errorText(r.error, "Couldn't join. Try again."), false);
          return;
        }
        const t = Array.isArray(r.data) ? r.data[0] : r.data;
        refreshWallet();
        goToPage("page-event", { arg: (t && t.id) || $("join-root").querySelector("[data-tid]").getAttribute("data-tid") });
      }).catch(function () {
        showMessage($("join-msg"), "Network error. Check your connection and try again.", false);
      });
    });
  }).finally(release);
}

// The link a signed-out visitor asked to come back to is open now: done.
function forgetPendingJoin(code) {
  try {
    const saved = JSON.parse(window.localStorage.getItem(PENDING_JOIN_KEY) || "null");
    if (saved && normalizeInviteCode(saved.code) === code) window.localStorage.removeItem(PENDING_JOIN_KEY);
  } catch (e) { /* storage blocked or corrupt */ }
}

function wire(root) {
  if (root.dataset.wired) return;
  root.dataset.wired = "1";
  root.addEventListener("click", function (e) {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-join-code")) join(b.getAttribute("data-join-code"), b);
    else if (b.hasAttribute("data-event")) goToPage("page-event", { arg: b.getAttribute("data-event") });
    else if (b.hasAttribute("data-manage")) goToPage("page-hosting", { arg: b.getAttribute("data-manage") });
  });
  root.addEventListener("submit", function (e) {
    if (e.target.id !== "join-code-form") return;
    e.preventDefault();
    const code = parseInviteInput($("join-code-input").value);
    if (!code) { $("join-code-input").setAttribute("aria-invalid", "true"); $("join-code-input").focus(); return; }
    goToPage("page-join", { arg: code });
  });
}

/* ---- signed out --------------------------------------------------------------- */

function rememberJoin(code) {
  try { window.localStorage.setItem(PENDING_JOIN_KEY, JSON.stringify({ code: code, at: Date.now() })); } catch (e) { /* storage blocked */ }
}

/**
 * The preview for a visitor without a session (the console isn't shown).
 * "Sign in to join" and "Create an account" remember the code first.
 */
export function renderGuest(arg) {
  const shell = $("join-guest");
  const root = $("join-guest-root");
  if (!shell || !root) return Promise.resolve();
  shell.hidden = false;
  const code = parseInviteInput(arg);
  if (!root.dataset.wired) {
    root.dataset.wired = "1";
    root.addEventListener("click", function (e) {
      const a = e.target.closest("[data-remember]");
      if (a && isInviteCode(a.getAttribute("data-remember"))) rememberJoin(normalizeInviteCode(a.getAttribute("data-remember")));
    });
  }
  const signIn = function (c) {
    return '<a class="btn btn--cta" href="login.html" data-remember="' + esc(c) + '">Sign in to join</a>' +
      '<a class="btn" href="signup.html" data-remember="' + esc(c) + '">Create an account</a>';
  };
  if (!code) {
    root.setAttribute("aria-busy", "false");
    root.innerHTML = '<div class="empty">' + peakArt("match") + "<h3>That invite link doesn't look right</h3><p>Ask the host for the link again, or sign in and type the code.</p>" +
      '<p><a class="btn btn--cta btn--sm" href="login.html">Sign in</a></p></div>';
    return Promise.resolve();
  }
  const client = getClient();
  return fetchPreview(client, code).then(function (res) {
    root.setAttribute("aria-busy", "false");
    if (res.error) {
      root.innerHTML = '<div class="empty">' + peakArt("match") + "<h3>We couldn't open this invite</h3><p>" +
        esc(errorText(res.error, "Sign in to see this tournament.")) + '</p><p class="tcard__act">' + signIn(code) + "</p></div>";
      return;
    }
    root.innerHTML = previewCard(res.preview, res.preview.status === "open" ? signIn(code) : signIn(code).replace("Sign in to join", "Sign in to follow it"));
  }).catch(function () {
    root.setAttribute("aria-busy", "false");
    root.innerHTML = '<p class="muted">You\'re offline. The invite loads when you reconnect.</p>';
  });
}
