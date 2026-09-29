/* ============================================================================
 * Runinback — console (dashboard) bootstrap.
 * Convenience gate + real data. The client-side redirect is only UX; the real
 * authorization boundary is Row Level Security in Postgres, and every balance
 * move goes through SECURITY DEFINER RPC functions (atomic escrow).
 * TEST MODE: the balance is simulated; real money will be non-custodial,
 * on-chain on Base (contracts + audit, Phase 3+).
 * ========================================================================== */
import { isBackendConfigured } from "../lib/config.js";
import { byId as $, setVisible } from "../lib/dom.js";
import { getClient, getSession } from "../lib/supabase-client.js";
import { fillNetworkSelect, initChallenges, loadChallenges, prepareFriendly } from "./challenges.js";
import { initContext, session } from "./context.js";
import { initRanking, loadProfileRecord, loadRanking } from "./leaderboard.js";
import { currentRouteArg, goToPage, initAmountChips, initNavigation, initialPage } from "./navigation.js";
import { initOps, loadOps } from "./ops.js";
import { initPlayer, loadPlayer } from "./player.js";
import {
  initAccountClosure, initGameAccounts, initProfile, loadGameAccounts, loadProfile, prepareLink, setGameAccountsListener, showProfileSection,
} from "./profile.js";
import { initSecurity, loadSecurity } from "./security.js";
import { initSettings, loadSettings } from "./settings.js";
import { initLiveWatch, urgentRoom } from "./live.js";
import { initRoom, loadRoom, openRoom } from "./room.js";
import { initTournaments, loadTournaments } from "./tournaments.js";
import { handleCheckoutReturn, initWallet, loadLedger, prepareTopUp, refreshWallet, updatePurchaseQuote } from "./wallet.js";

// Three steps from "just signed up" to "playing for a prize", on the Play
// page until the player hides them. Remembered per browser only.
const ONBOARD_KEY = "rib:onboard-hidden";
function initOnboarding() {
  const box = $("onboard");
  if (!box) return;
  let hidden = false;
  try { hidden = window.localStorage.getItem(ONBOARD_KEY) === "1"; } catch (e) { /* storage blocked */ }
  setVisible(box, !hidden);
  $("onboard-dismiss").addEventListener("click", function () {
    setVisible(box, false);
    try { window.localStorage.setItem(ONBOARD_KEY, "1"); } catch (e) { /* storage blocked */ }
  });
}

function redirectToLanding() {
  window.location.replace("index.html");
}

// The games engine (27 games) is its own chunk, fetched when Play opens.
let gamesEngine = null;
function loadGames() {
  if (!$("games-root")) return;
  gamesEngine = gamesEngine || import("../games/engine.js");
  gamesEngine
    .then(function (engine) {
      engine.initGames({ client: session.client, UID: session.uid, refreshWallet: refreshWallet, configured: true });
    })
    .catch(function () {
      gamesEngine = null; // let the next visit retry
      $("games-root").innerHTML = '<p class="muted">Couldn\'t load the games. Check your connection and open Play again.</p>';
    });
}

// Tournament and friendly forms offer only the game accounts this player
// linked. A failed read (null) keeps whatever the selects already offer.
function fillAccountSelects(rows) {
  if (!rows) return;
  fillNetworkSelect($("tournament-network"), rows);
  fillNetworkSelect($("challenge-network"), rows);
}
function loadGameAccountSelects() {
  return loadGameAccounts().then(fillAccountSelects);
}

const PAGE_LOADERS = {
  "page-games": loadGames,
  "page-compete": function () {
    loadTournaments(); loadChallenges(); loadGameAccountSelects();
    if (currentRouteArg()) prepareFriendly(currentRouteArg());
  },
  "page-room": loadRoom,
  "page-ops": loadOps,
  "page-wallet": function () { refreshWallet(); loadLedger(); if (currentRouteArg()) prepareTopUp(currentRouteArg()); },
  "page-ranking": loadRanking,
  "page-profile": function () {
    const section = showProfileSection(currentRouteArg());
    if (section === "settings") { loadSettings(); return; }
    if (section === "security") { loadSecurity(); return; }
    loadProfile(); loadProfileRecord();
    loadGameAccountSelects().then(function () { if (currentRouteArg()) prepareLink(currentRouteArg()); });
  },
  "page-player": function () { loadPlayer(currentRouteArg()); },
};

function showAccount(user) {
  const meta = user.user_metadata || {};
  $("acct-name").textContent = meta.username ? "@" + meta.username : (user.email || "");
  $("acct-email").textContent = user.email || "";
}

export function initConsole() {
  const loading = $("console-loading");

  if (!isBackendConfigured()) {
    if (loading) loading.innerHTML =
      '<p class="muted">The backend isn\'t connected yet. Set SUPABASE_URL and SUPABASE_ANON_KEY in the Vercel environment variables.</p>';
    return;
  }

  getSession().then(function (current) {
    if (!current) { redirectToLanding(); return; }
    initContext(getClient(), current.user.id);
    if (loading) loading.style.display = "none";
    setVisible($("capp"), true);
    showAccount(current.user || {});

    initNavigation(PAGE_LOADERS);
    initAmountChips(function (group, amountCents) {
      if (group !== "buy-amount") return;
      $("buy-amount").value = String(amountCents / 100);
      updatePurchaseQuote();
    });
    initProfile();
    initGameAccounts();
    setGameAccountsListener(fillAccountSelects);
    initSettings();
    initSecurity();
    initPlayer();
    initRoom();
    initOps();
    initAccountClosure();
    initChallenges();
    initTournaments();
    initRanking();
    initWallet();
    initOnboarding();

    refreshWallet();
    loadProfile();
    // Honor a deep link (#page-wallet) and give the first page a history state.
    const start = initialPage() || "page-games";
    try { window.history.replaceState({ page: start, arg: currentRouteArg() }, "", window.location.href); } catch (e) { /* ignore */ }
    if (start === "page-games") loadGames();
    else goToPage(start, { fromHistory: true, arg: currentRouteArg() });
    // Live matches on every page; a returning player with a match that needs
    // them right now lands in that room instead of the games list.
    const deepLinked = !!initialPage();
    initLiveWatch().then(function () {
      const urgent = urgentRoom();
      if (urgent && !deepLinked) openRoom(urgent.id);
    });
    handleCheckoutReturn(goToPage);
  }).catch(function (e) {
    // A bug during boot must not look like "signed out" without a trace.
    console.error("console boot failed", e);
    redirectToLanding();
  });
}
