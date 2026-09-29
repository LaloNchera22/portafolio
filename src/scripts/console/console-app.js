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
import { initGames } from "../games/engine.js";
import { initChallenges, loadChallenges } from "./challenges.js";
import { initContext, session } from "./context.js";
import { initDeveloperPortal, loadDeveloperMetrics, loadKeys, loadProjects } from "./developer.js";
import { initRanking, loadProfileRecord, loadRanking } from "./leaderboard.js";
import { goToPage, initAmountChips, initNavigation } from "./navigation.js";
import { initProfile, loadProfile } from "./profile.js";
import { initTournaments, loadTournaments } from "./tournaments.js";
import { handleCheckoutReturn, initWallet, loadLedger, refreshWallet, updatePurchaseQuote } from "./wallet.js";

function redirectToLanding() {
  window.location.replace("index.html");
}

function loadGames() {
  if (!$("games-root")) return;
  initGames({ client: session.client, UID: session.uid, refreshWallet: refreshWallet, configured: true });
}

const PAGE_LOADERS = {
  "page-games": loadGames,
  "page-compete": function () { loadChallenges(); loadTournaments(); },
  "page-wallet": function () { refreshWallet(); loadLedger(); },
  "page-ranking": loadRanking,
  "page-profile": function () { loadProfile(); loadProfileRecord(); },
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
    initDeveloperPortal();
    initChallenges();
    initTournaments();
    initRanking();
    initWallet();

    refreshWallet();
    loadProfile();
    loadGames();
    handleCheckoutReturn(goToPage);
  }).catch(redirectToLanding);
}
