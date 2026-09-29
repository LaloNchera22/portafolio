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
import { fillNetworkSelect, initChallenges, loadChallenges } from "./challenges.js";
import { initContext, session } from "./context.js";
import { initDeveloperPortal, loadDeveloperMetrics, loadKeys, loadProjects } from "./developer.js";
import { initRanking, loadProfileRecord, loadRanking } from "./leaderboard.js";
import { currentRouteArg, goToPage, initAmountChips, initNavigation, initialPage } from "./navigation.js";
import { initOps, loadOps } from "./ops.js";
import { initAccountClosure, initGameAccounts, initProfile, loadGameAccounts, loadProfile, prepareLink } from "./profile.js";
import { initLiveWatch, urgentRoom } from "./live.js";
import { initRoom, loadRoom, openRoom } from "./room.js";
import { initTournaments, loadTournaments } from "./tournaments.js";
import { handleCheckoutReturn, initWallet, loadLedger, prepareTopUp, refreshWallet, updatePurchaseQuote } from "./wallet.js";

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

// Tournament and friendly forms offer only the game accounts this player linked.
function loadGameAccountSelects() {
  return loadGameAccounts().then(function (rows) {
    fillNetworkSelect($("tournament-network"), rows);
    fillNetworkSelect($("challenge-network"), rows);
  });
}

const PAGE_LOADERS = {
  "page-games": loadGames,
  "page-compete": function () { loadTournaments(); loadChallenges(); loadGameAccountSelects(); },
  "page-room": loadRoom,
  "page-ops": loadOps,
  "page-wallet": function () { refreshWallet(); loadLedger(); if (currentRouteArg()) prepareTopUp(currentRouteArg()); },
  "page-ranking": loadRanking,
  "page-profile": function () {
    loadProfile(); loadProfileRecord();
    loadGameAccountSelects().then(function () { if (currentRouteArg()) prepareLink(currentRouteArg()); });
  },
  "page-developer": function () { loadProjects(); loadKeys(); loadDeveloperMetrics(); refreshWallet(); },
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
    initRoom();
    initOps();
    initAccountClosure();
    initDeveloperPortal();
    initChallenges();
    initTournaments();
    initRanking();
    initWallet();

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
