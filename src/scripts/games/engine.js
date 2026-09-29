/* ============================================================================
 * Runinback — Games engine. Casual multiplayer games on the dashboard.
 *
 * Two ways to play every game:
 *   • Practice vs the house bot — free, offline, always available.
 *   • Play for rcoin — a staked 1v1 over Supabase Realtime. Both players stake
 *     the same amount, the winner takes the whole pot (no rake: the 5% is
 *     charged once when you buy rcoin, never on the table). Board state syncs
 *     over Realtime; every move is validated by the game-move Edge Function,
 *     and the pot settles automatically when the rules say the game is over,
 *     on resign, or when a player's turn clock runs out.
 *
 * Game rules live in ./catalog (one module per game: init/legal/apply/result/
 * bot/view). This engine runs the lobby, the turn loop, the bot, the result
 * screen and (online) the sync.
 * ========================================================================== */
import { el, escapeHtml as esc } from "../lib/dom.js";
import { centsToRcoin as rcoin } from "../lib/format.js";
import { functionError, notify } from "../lib/errors.js";
import { CORE_GAMES } from "./catalog/core-games.js";
import { EXTRA_GAMES } from "./catalog/extra-games.js";
import { COMING_SOON_GAMES, isStakeable } from "./catalog/catalog-meta.js";
import { parseStake } from "../lib/stake.js";
import { GAME_HELP } from "./help.js";


// Catalog order: the core six, then the extra pack, then "coming soon".
var MODULES = {};
var CATALOG = [];
CORE_GAMES.concat(EXTRA_GAMES).forEach(function (mod) { MODULES[mod.id] = mod; CATALOG.push(mod); });
COMING_SOON_GAMES.forEach(function (g) { CATALOG.push(g); });

/* =========================================================================
 * DRIVER — runs a single game (practice vs bot, or online for rcoin).
 * ========================================================================= */
var CTX = null;   // { client, UID, refreshWallet, configured }
var host = null;  // container element for the games page

function h(id) { return document.getElementById(id); }

/* ---- accessibility helpers -------------------------------------------------- */
// Accessible modal: labelled by its title, focus moves in and stays trapped,
// Escape closes only this (top-most) modal, and focus returns to the opener.
var FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';
var modalSeq = 0;
function mountModal(backdrop, panel, labelEl) {
  var opener = document.activeElement;
  if (labelEl) {
    labelEl.id = labelEl.id || "gmodal-title-" + (++modalSeq);
    panel.setAttribute("aria-labelledby", labelEl.id);
  }
  panel.tabIndex = -1;
  var closed = false;
  function close(restoreFocus) {
    if (closed) return;
    closed = true;
    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    if (restoreFocus !== false && opener && opener.focus && document.contains(opener)) opener.focus();
  }
  panel.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key !== "Tab") return;
    var items = panel.querySelectorAll(FOCUSABLE);
    if (!items.length) { e.preventDefault(); return; }
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  backdrop.addEventListener("click", function (e) { if (e.target === backdrop) close(); });
  // Mount inside the .capp shell so the overlay picks up the console styles.
  var root = (host && host.closest && host.closest(".capp")) || document.querySelector(".capp") || document.body;
  root.appendChild(backdrop);
  var firstItem = panel.querySelector(FOCUSABLE);
  (firstItem || panel).focus();
  return close;
}

// Board cells are buttons drawn by each game's view. Give unlabelled ones a
// spoken name ("Square 5, X" / "Square 5, empty") and keep keyboard focus on
// the same square across re-renders, so a move doesn't drop focus to <body>.
function boardFocusIndex(board) {
  return Array.prototype.indexOf.call(board.querySelectorAll("button"), document.activeElement);
}
function afterBoardRender(board, focusIndex) {
  var buttons = board.querySelectorAll("button");
  Array.prototype.forEach.call(buttons, function (b, i) {
    if (b.type !== "button") b.type = "button";
    if (b.hasAttribute("aria-label")) return;
    var text = (b.textContent || "").trim();
    b.setAttribute("aria-label", "Square " + (i + 1) + ", " + (text || "empty") + (b.disabled ? "" : ", available"));
  });
  if (focusIndex >= 0) {
    var target = buttons[focusIndex] && !buttons[focusIndex].disabled ? buttons[focusIndex] : board.querySelector("button:not([disabled])");
    if (target) target.focus();
  }
}

/* ---- how-to-play overlay ------------------------------------------------ */
function getHelp(id) { return GAME_HELP[id] || null; }

// small round "?" button that opens the how-to-play overlay for a game
function helpButton(gameId) {
  var b = el("button", "ghelp-btn", "?");
  b.type = "button";
  b.title = "How to play";
  b.setAttribute("aria-label", "How to play");
  b.addEventListener("click", function () { showHelp(gameId); });
  return b;
}

function showHelp(gameId) {
  var mod = MODULES[gameId] || null;
  var meta = mod || CATALOG.filter(function (g) { return g.id === gameId; })[0] || { name: gameId, icon: "?" };
  var help = getHelp(gameId);

  var back = el("div", "ghelp-back");
  var panel = el("div", "ghelp");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  var head = el("div", "ghelp__head");
  head.innerHTML = '<span class="ghelp__ic">' + esc(meta.icon || "?") + '</span>' +
    '<span class="ghelp__title">' + esc(meta.name) + '</span>';
  var x = el("button", "ghelp__x", "✕"); x.type = "button"; x.setAttribute("aria-label", "Close");
  head.appendChild(x);
  panel.appendChild(head);

  var body = el("div", "ghelp__body");
  if (help) {
    if (help.you) { var yo = el("p", "ghelp__you"); yo.textContent = help.you; body.appendChild(yo); }
    if (help.how && help.how.length) {
      body.appendChild(el("h4", "ghelp__h", "How to play"));
      var ol = el("ol", "ghelp__steps");
      help.how.forEach(function (step) { ol.appendChild(el("li", null, step)); });
      body.appendChild(ol);
    }
    if (help.win) {
      body.appendChild(el("h4", "ghelp__h", help.soon ? "Objective" : "How to win"));
      body.appendChild(el("p", "ghelp__win", help.win));
    }
    if (help.tip) {
      var tip = el("p", "ghelp__tip"); tip.innerHTML = '<b>Tip.</b> ' + esc(help.tip); body.appendChild(tip);
    }
  } else {
    body.appendChild(el("p", "ghelp__win", meta.blurb || "Tap the highlighted squares to play."));
  }
  panel.appendChild(body);

  var foot = el("div", "ghelp__foot");
  var ok = el("button", "btn btn--cta", help && help.soon ? "Close" : "Got it");
  foot.appendChild(ok); panel.appendChild(foot);

  back.appendChild(panel);
  var close = mountModal(back, panel, head.querySelector(".ghelp__title"));
  x.addEventListener("click", function () { close(); });
  ok.addEventListener("click", function () { close(); });
}

export function initGames(ctx) {
  CTX = ctx || {};
  host = h("games-root");
  if (!host) return;
  // Coming back to the games page must not wipe a match or practice board.
  if (online || host.querySelector(".gstage")) return;
  renderLobby();
}

// Refresh a live board when the tab becomes visible again (missed events).
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible" && online) resyncOnline();
});

/* ---- lobby -------------------------------------------------------------- */
// Card games (the rest are boards). Fast = a match that wraps up in ~3 min.
var CARD_IDS = { eights: 1, gofish: 1, memory: 1 };
var FAST_IDS = { tictactoe: 1, connect4: 1, nim: 1, chomp: 1, misere: 1, hexapawn: 1, ponghau: 1, fifteen: 1, kayles: 1 };
function matchesFilter(g, f) {
  if (f === "all") return true;
  if (f === "fast") return !!FAST_IDS[g.id];
  if (f === "cards") return !!CARD_IDS[g.id];
  if (f === "board") return !CARD_IDS[g.id];
  return true;
}
var lobbyFilter = "all";

function renderLobby() {
  stopOnline();
  host.innerHTML = "";
  // The intro copy is the static .games-lead in console.html, above this
  // root — don't re-append it here or it shows twice.

  // category filters
  var filters = [
    { f: "all", label: "All" },
    { f: "fast", label: "Fast · 3 min or less" },
    { f: "cards", label: "Cards" },
    { f: "board", label: "Boards" }
  ];
  var bar = el("div", "games-filters");
  filters.forEach(function (it) {
    var b = el("button", "gfilter" + (it.f === lobbyFilter ? " on" : ""), it.label);
    b.type = "button";
    b.addEventListener("click", function () {
      lobbyFilter = it.f;
      bar.querySelectorAll(".gfilter").forEach(function (x) { x.classList.remove("on"); });
      b.classList.add("on");
      drawGrid();
    });
    bar.appendChild(b);
  });
  host.appendChild(bar);

  var grid = el("div", "games-grid");
  host.appendChild(grid);

  function drawGrid() {
    grid.innerHTML = "";
    var shown = 0;
    CATALOG.forEach(function (g) {
      if (g.soon) return;                       // coming-soon games are hidden from the lobby
      if (!matchesFilter(g, lobbyFilter)) return;
      shown++;
      // The whole card is the tap target — a big, mobile-friendly hit area
      // that takes you straight into the game screen (practice vs bot or
      // play for rcoin). The rules live inside that screen (auto on first
      // open, and via "How to play"), so there's no dead-end here.
      var card = el("button", "gcard");
      card.type = "button";
      card.setAttribute("aria-label", "Open " + g.name);
      card.innerHTML =
        '<span class="gcard__ic">' + esc(g.icon) + '</span>' +
        '<span class="gcard__n">' + esc(g.name) + '</span>' +
        '<span class="gcard__d">' + esc(g.blurb) + '</span>';
      var foot = el("span", "gcard__foot");
      foot.appendChild(el("span", "gcard__tag", g.tag));
      foot.appendChild(el("span", "gcard__play", "Play ›"));
      card.appendChild(foot);
      card.addEventListener("click", function () { openGame(g.id); });
      grid.appendChild(card);
    });
    if (!shown) grid.innerHTML = '<p class="games-intro" style="margin:0">No games in this filter.</p>';
  }
  drawGrid();

  // your own staked tables: resume a live match, or cancel a table nobody joined
  var mineWrap = el("div", "games-open");
  mineWrap.id = "games-mine";
  host.appendChild(mineWrap);
  loadMyTables();

  // open online tables to join (staked, if backend live) — plain list, no decoration
  var openWrap = el("div", "games-open");
  openWrap.id = "games-open";
  host.appendChild(openWrap);
  loadOpenTables();
}

/* ---- a game screen (mode chooser) ---------------------------------------
 * A pop-up over the lobby: the game's identity up top (icon, name, the
 * side you play, a quiet "How to play"), then the two ways to play ranked
 * by hairline — free practice first, then a staked table with a live pot
 * preview. Picking a mode dismisses the pop-up and drops you into the
 * game's own sub-page (the board). Depth comes from geometry, not shadows.
 * ------------------------------------------------------------------------ */
function openGame(gameId) {
  var mod = MODULES[gameId];
  var help = getHelp(gameId);

  var backdrop = el("div", "gmodal-back");
  var panel = el("div", "gplay gplay--modal");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  var closeModal = null;
  function close(restoreFocus) { if (closeModal) closeModal(restoreFocus); }
  // launch a mode: dismiss the pop-up (focus moves to the new screen), then render it
  function launch(fn) { close(false); fn(); }

  // identity header
  var head = el("div", "gplay__head");
  head.appendChild(el("div", "gplay__ic", mod.icon));
  var idcol = el("div", "gplay__id");
  idcol.appendChild(el("h2", "gplay__name", mod.name));
  if (help && help.you) idcol.appendChild(el("p", "gplay__you", help.you));
  head.appendChild(idcol);
  var how = el("button", "btn btn--sm gplay__how", "How to play");
  how.addEventListener("click", function () { showHelp(gameId); });
  head.appendChild(how);
  var x = el("button", "gplay__x", "✕"); x.type = "button"; x.setAttribute("aria-label", "Close");
  x.addEventListener("click", close);
  head.appendChild(x);
  panel.appendChild(head);

  // option 1 — free practice
  var free = el("div", "gplay__opt gplay__opt--free");
  var freeL = el("div", "gplay__optL");
  freeL.appendChild(el("p", "gplay__eyebrow", "Free"));
  freeL.appendChild(el("h3", "gplay__optH", "Practice vs the bot"));
  freeL.appendChild(el("p", "gplay__optD", "A warm-up against the house bot. No stake, play as many as you like."));
  free.appendChild(freeL);
  var pBtn = el("button", "btn btn--cta gplay__act", "Play free");
  pBtn.addEventListener("click", function () { launch(function () { startPractice(gameId); }); });
  free.appendChild(pBtn);
  panel.appendChild(free);

  // option 2 — staked table
  var coin = el("div", "gplay__opt");
  var coinL = el("div", "gplay__optL");
  coinL.appendChild(el("p", "gplay__eyebrow", "Staked · winner takes all"));
  coinL.appendChild(el("h3", "gplay__optH", "Play for rcoin"));
  coinL.appendChild(el("p", "gplay__optD", "Both players stake the same. No rake on the table — the whole pot goes to the winner."));
  coin.appendChild(coinL);

  var coinR = el("div", "gplay__optR");
  coinR.appendChild(el("p", "gplay__stakeLbl", "Your stake (rcoin)"));
  // low presets so anyone can join, plus a free-typed custom amount
  var stakeRow = el("div", "gplay__stakes");
  var custom = el("input", "gplay__custom");
  custom.type = "number"; custom.min = "1"; custom.step = "1"; custom.inputMode = "numeric"; custom.placeholder = "Custom";
  custom.setAttribute("aria-label", "Custom stake in rcoin");
  var pot = el("p", "gplay__pot");
  // the active stake: a typed custom amount wins, else the selected chip.
  // An invalid custom amount is an error, never a silent fallback.
  function currentStake() {
    if (custom.value !== "") {
      var parsed = parseStake(custom.value);
      return parsed.error ? { error: parsed.error } : { rcoin: parsed.rcoin };
    }
    var on = stakeRow.querySelector("button.on");
    return on ? { rcoin: parseInt(on.getAttribute("data-r"), 10) } : { error: "Pick a stake." };
  }
  function setPot() {
    var s = currentStake();
    if (s.error) { pot.textContent = s.error; pot.classList.add("is-error"); }
    else { pot.innerHTML = 'Winner takes <b>' + (s.rcoin * 2) + ' rcoin</b>'; pot.classList.remove("is-error"); }
    if (cBtn && CTX.configured && isStakeable(gameId)) cBtn.disabled = !!s.error;
  }
  var cBtn = null;
  [1, 5, 10, 25].forEach(function (r, i) {
    var b = el("button", "gplay__stake" + (i === 1 ? " on" : ""), String(r));
    b.setAttribute("data-r", r);
    b.addEventListener("click", function () { custom.value = ""; stakeRow.querySelectorAll("button").forEach(function (x) { x.classList.remove("on"); }); b.classList.add("on"); setPot(); });
    stakeRow.appendChild(b);
  });
  coinR.appendChild(stakeRow);
  custom.addEventListener("input", function () { stakeRow.querySelectorAll("button").forEach(function (x) { x.classList.remove("on"); }); setPot(); });
  coinR.appendChild(custom);
  setPot();
  coinR.appendChild(pot);
  cBtn = el("button", "btn gplay__act", "Create table");
  cBtn.addEventListener("click", function () {
    var s = currentStake();
    if (s.error) { setPot(); custom.focus(); return; }
    launch(function () { createOnline(gameId, s.rcoin * 100, cBtn); });
  });
  coinR.appendChild(cBtn);
  var note = el("p", "gplay__note");
  coinR.appendChild(note);
  if (!CTX.configured) { cBtn.disabled = true; note.textContent = "Staked tables open once the backend is connected. Practice works now."; }
  else if (!isStakeable(gameId)) { cBtn.disabled = true; note.textContent = "Staked tables for this game are coming soon. Practice works now."; }
  coin.appendChild(coinR);
  panel.appendChild(coin);

  backdrop.appendChild(panel);
  closeModal = mountModal(backdrop, panel, panel.querySelector(".gplay__name"));
}

/* ---- practice loop (seat 0 = you, seat 1 = bot) ------------------------- */
function startPractice(gameId) {
  var mod = MODULES[gameId];
  var state = mod.init();
  var api = makeApi(mod, function () { return state; }, { online: false });
  host.innerHTML = "";
  var top = el("div", "gscreen__top");
  var back = el("button", "btn btn--sm", "‹ Leave");
  back.addEventListener("click", renderLobby);
  top.appendChild(back);
  top.appendChild(el("h2", "gscreen__name", mod.name + " · practice"));
  top.appendChild(helpButton(gameId));
  host.appendChild(top);
  var stageWrap = el("div", "gstage");
  var legend = getHelp(gameId);
  if (legend && legend.you) stageWrap.appendChild(el("p", "gyou", legend.you));
  var turnbar = el("div", "gturn"); turnbar.id = "g-turn";
  turnbar.setAttribute("role", "status");
  var board = el("div", "gboard"); board.id = "g-board";
  var over = el("div", "gover"); over.id = "g-over"; over.hidden = true;
  stageWrap.appendChild(turnbar); stageWrap.appendChild(board); stageWrap.appendChild(over);
  host.appendChild(stageWrap);

  api.oppName = "Bot";
  function draw() {
    var focusIndex = boardFocusIndex(board);
    board.innerHTML = "";
    var res = mod.result(state);
    api.canMove = !res && state.turn === 0;
    mod.view(state, apiFor(board));
    afterBoardRender(board, focusIndex);
    if (res) return finishPractice(res);
    turnbar.textContent = state.turn === 0 ? "Your turn." : "Bot is thinking…";
    turnbar.className = "gturn " + (state.turn === 0 ? "you" : "opp");
    if (state.turn === 1) setTimeout(botStep, 620);
  }
  function apiFor(boardEl) { api.board = boardEl; api.rerender = draw; return api; }
  function move(m) {
    if (state.turn !== 0) return;
    state = mod.apply(state, m);
    draw();
  }
  function botStep() {
    var res = mod.result(state); if (res) return finishPractice(res);
    if (state.turn !== 1) return draw();
    var m = mod.bot(state);
    state = mod.apply(state, m);
    // some games (mancala) can grant the same seat another turn
    var res2 = mod.result(state);
    if (!res2 && state.turn === 1) { draw(); return setTimeout(botStep, 620); }
    draw();
  }
  api._move = move;
  function finishPractice(res) {
    api.canMove = false;
    board.innerHTML = ""; mod.view(state, apiFor(board));
    afterBoardRender(board, -1);
    turnbar.textContent = "";
    over.hidden = false;
    var won = res.winner === 0, draw2 = res.winner == null;
    over.innerHTML = '<h3 class="' + (draw2 ? "" : (won ? "win" : "lose")) + '">' + (draw2 ? "Draw" : (won ? "You win" : "Bot wins")) + '</h3>' +
      '<p>Practice round — no rcoin at stake.</p>';
    var acts = el("div", "gover__acts");
    var again = el("button", "btn btn--cta", "Play again"); again.addEventListener("click", function () { startPractice(gameId); });
    var leave = el("button", "btn", "All games"); leave.addEventListener("click", renderLobby);
    acts.appendChild(again); acts.appendChild(leave); over.appendChild(acts);
    again.focus();
  }
  // wire move through api
  api.move = move;
  draw();
}

// shared api factory: exposes move/rerender bound later; per-game scratch (_ck,_ce)
function makeApi(mod, getState, opts) {
  return { board: null, canMove: false, oppName: "Rival", move: function () {}, rerender: function () {}, online: !!(opts && opts.online) };
}

/* =========================================================================
 * ONLINE (staked) — create/join, sync over Realtime, report + settle.
 * ========================================================================= */
var online = null; // { match, mod, seat, channel, state }

function stopOnline() {
  if (online && online.channel) { try { CTX.client.removeChannel(online.channel); } catch (e) {} }
  if (online && online.timer) clearInterval(online.timer);
  online = null;
}

function loadOpenTables() {
  var box = h("games-open"); if (!box) return;
  if (!CTX.configured) { box.innerHTML = ""; return; }
  CTX.client.from("game_matches").select("id, game, stake_cents, host_id, created_at").eq("status", "open").neq("host_id", CTX.UID).order("created_at", { ascending: false }).limit(20)
    .then(function (r) {
      var rows = (r.data) || [];
      if (r.error) { box.innerHTML = '<p class="muted">Couldn\'t load open tables. They\'ll show up when you come back to this page.</p>'; return; }
      if (!rows.length) { box.innerHTML = ""; return; }
      box.innerHTML = '<div class="sec__head"><h2>Open tables</h2><span class="sec__note">staked, waiting for a player</span></div>';
      var panel = el("div", "panel");
      rows.forEach(function (m) {
        var mod = MODULES[m.game]; if (!mod) return;
        var row = el("div", "row row--challenge");
        row.innerHTML = '<div><div class="row__name">' + esc(mod.name) + ' · ' + rcoin(m.stake_cents) + ' rcoin</div><div class="row__meta">pot ' + rcoin(m.stake_cents * 2) + ' rcoin · winner takes all</div></div>';
        var act = el("div", "row__act");
        var join = el("button", "btn btn--cta btn--sm", "Join for " + rcoin(m.stake_cents) + " rcoin");
        join.addEventListener("click", function () { joinOnline(m, join); });
        act.appendChild(join); row.appendChild(act); panel.appendChild(row);
      });
      box.appendChild(panel);
    });
}

// Until the first move the authoritative position is the rules' initial one
// (the server ignores whatever state the host stored); mirrors game-move-core.
function authoritativeState(match, mod) {
  var st = match && match.state;
  return match && match.move_seq > 0 && st && typeof st.turn === "number" ? st : mod.init();
}

function loadMyTables() {
  var box = h("games-mine"); if (!box) return;
  if (!CTX.configured) { box.innerHTML = ""; return; }
  CTX.client.from("game_matches").select("*")
    .or("host_id.eq." + CTX.UID + ",guest_id.eq." + CTX.UID)
    .in("status", ["open", "active"])
    .order("created_at", { ascending: false }).limit(20)
    .then(function (r) {
      if (r.error) { box.innerHTML = '<p class="muted">Couldn\'t load your tables. Reopen this page to try again.</p>'; return; }
      var rows = (r.data || []).filter(function (m) { return MODULES[m.game]; });
      if (!rows.length) { box.innerHTML = ""; return; }
      box.innerHTML = '<div class="sec__head"><h2>Your tables</h2><span class="sec__note">staked, in progress</span></div>';
      var panel = el("div", "panel");
      rows.forEach(function (m) {
        var mod = MODULES[m.game];
        var seat = m.host_id === CTX.UID ? 0 : 1;
        var row = el("div", "row row--challenge");
        var waiting = m.status === "open";
        var yourTurn = !waiting && m.turn_id === CTX.UID;
        row.innerHTML = '<div><div class="row__name">' + esc(mod.name) + ' · ' + rcoin(m.stake_cents * 2) + ' rcoin pot</div><div class="row__meta">' +
          (waiting ? "waiting for a player" : (yourTurn ? "your turn" : "opponent's turn")) + '</div></div>';
        var act = el("div", "row__act");
        var resume = el("button", "btn btn--cta btn--sm", waiting ? "Open" : "Resume");
        resume.addEventListener("click", function () { enterOnline(m, mod, seat, waiting ? "Waiting for a player to join…" : null); });
        act.appendChild(resume);
        if (waiting && seat === 0) {
          var cancel = el("button", "btn btn--sm btn--danger", "Cancel");
          cancel.addEventListener("click", function () { cancelTable(m, cancel, loadMyTables); });
          act.appendChild(cancel);
        }
        row.appendChild(act); panel.appendChild(row);
      });
      box.appendChild(panel);
    });
}

// Host only, before anyone joins: the stake goes straight back to the wallet.
function cancelTable(match, btn, after) {
  if (!window.confirm("Cancel this table? Your " + rcoin(match.stake_cents) + " rcoin stake goes back to your wallet.")) return;
  btn.disabled = true;
  CTX.client.rpc("rib_game_cancel", { p_match_id: match.id })
    .then(function (r) {
      if (r.error) { btn.disabled = false; notify(r.error, "We couldn't cancel this table. Please try again."); return; }
      notify(null, "Table cancelled. Your stake is back in your wallet.", "ok");
      if (CTX.refreshWallet) CTX.refreshWallet();
      if (after) after();
    })
    .catch(function () { btn.disabled = false; notify(null, "Network error. Check your connection and try again."); });
}

function createOnline(gameId, stakeCents, btn) {
  if (!CTX.configured) return;
  var mod = MODULES[gameId];
  btn.disabled = true;
  CTX.client.rpc("rib_game_create", { p_game: gameId, p_stake_cents: stakeCents, p_state: mod.init() })
    .then(function (r) {
      if (r.error) { notify(r.error, "We couldn't create the table. Please try again."); btn.disabled = false; return; }
      if (CTX.refreshWallet) CTX.refreshWallet();
      enterOnline(r.data, mod, 0, "Waiting for a player to join…");
    })
    .catch(function () { btn.disabled = false; notify(null, "Network error. Check your connection and try again."); });
}

function joinOnline(match, btn) {
  if (!CTX.configured) return;
  var mod = MODULES[match.game]; if (!mod) return;
  btn.disabled = true;
  CTX.client.rpc("rib_game_join", { p_match_id: match.id, p_state: null })
    .then(function (r) {
      if (r.error) { notify(r.error, "We couldn't join this table. Please try again."); btn.disabled = false; loadOpenTables(); return; }
      if (CTX.refreshWallet) CTX.refreshWallet();
      enterOnline(r.data, mod, 1, null);
    })
    .catch(function () { btn.disabled = false; notify(null, "Network error. Check your connection and try again."); });
}

// Every staked move goes through the game-move Edge Function, which validates
// it with the shared rules and settles the pot when the game ends.
function sendToServer(body) {
  return CTX.client.functions.invoke("game-move", { body: body }).then(function (r) {
    if (!r.error) return r.data && r.data.match;
    return functionError(r.error).then(function (err) { throw err; });
  });
}

function resyncOnline() {
  if (!online) return;
  CTX.client.from("game_matches").select("*").eq("id", online.match.id).single()
    .then(function (r) {
      if (!r.error && r.data) onlineUpdate(r.data);
      else notify(r.error, "Couldn't refresh the board. It will update on the next move.", "info");
    })
    .catch(function () { notify(null, "You're offline. The board will refresh when you reconnect.", "info"); });
}

// Waiting player: claim the pot once the opponent's turn clock has run out.
function claimOnTime(btn) {
  btn.disabled = true;
  CTX.client.rpc("rib_game_claim_timeout", { p_match_id: online.match.id })
    .then(function (r) {
      if (r.error) { btn.disabled = false; notify(r.error, "Couldn't claim the win yet."); resyncOnline(); return; }
      onlineUpdate(r.data);
    })
    .catch(function () { btn.disabled = false; notify(null, "Network error. Check your connection and try again."); });
}

function clockText(deadline) {
  var ms = new Date(deadline).getTime() - Date.now();
  if (!isFinite(ms)) return "";
  if (ms <= 0) return "0:00";
  var total = Math.ceil(ms / 1000);
  return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
}

function enterOnline(match, mod, seat, waitMsg) {
  stopOnline();
  online = { match: match, mod: mod, seat: seat, state: authoritativeState(match, mod), channel: null, pending: false };
  host.innerHTML = "";
  var top = el("div", "gscreen__top");
  var back = el("button", "btn btn--sm", "‹ Leave");
  back.addEventListener("click", function () { stopOnline(); renderLobby(); });
  top.appendChild(back);
  top.appendChild(el("h2", "gscreen__name", mod.name + " · " + rcoin(match.stake_cents * 2) + " rcoin pot"));
  var resign = el("button", "btn btn--sm btn--danger", "Resign");
  resign.hidden = true;
  resign.addEventListener("click", function () {
    if (!online) return;
    if (online.match.status === "open") {
      return cancelTable(online.match, resign, function () { stopOnline(); renderLobby(); });
    }
    if (online.match.status !== "active") return;
    if (!window.confirm("Resign this match? Your opponent takes the pot.")) return;
    resign.disabled = true;
    sendToServer({ match_id: online.match.id, action: "resign" })
      .then(function (m) { if (m) onlineUpdate(m); })
      .catch(function (e) { resign.disabled = false; notify(e, "We couldn't resign right now. Please try again."); });
  });
  top.appendChild(resign);
  top.appendChild(helpButton(mod.id));
  host.appendChild(top);
  var stageWrap = el("div", "gstage");
  var oLegend = getHelp(mod.id);
  // piece colors follow seat 0/1, so the "you play …" legend only holds for the host
  if (seat === 0 && oLegend && oLegend.you) stageWrap.appendChild(el("p", "gyou", oLegend.you));
  var turnbar = el("div", "gturn"); turnbar.id = "g-turn";
  turnbar.setAttribute("role", "status");
  var clock = el("div", "gclock");
  var clockText_ = el("span", "gclock__time");
  var claim = el("button", "btn btn--cta btn--sm", "Claim win");
  claim.hidden = true;
  claim.addEventListener("click", function () { claimOnTime(claim); });
  clock.appendChild(clockText_); clock.appendChild(claim);
  var board = el("div", "gboard"); board.id = "g-board";
  var over = el("div", "gover"); over.id = "g-over"; over.hidden = true;
  over.setAttribute("role", "alert");
  stageWrap.appendChild(turnbar); stageWrap.appendChild(clock); stageWrap.appendChild(board); stageWrap.appendChild(over);
  host.appendChild(stageWrap);

  // Turn clock: each move has a deadline; when the opponent's runs out, the
  // waiting player can claim the pot (the server also forfeits on its own).
  function tickClock() {
    var m = online && online.match;
    if (!m || m.status !== "active" || !m.turn_deadline) { clock.hidden = true; return; }
    clock.hidden = false;
    var mine = m.turn_id === CTX.UID;
    var left = clockText(m.turn_deadline);
    var expired = left === "0:00";
    clockText_.textContent = (mine ? "Your time to move: " : "Opponent's time to move: ") + left;
    clock.classList.toggle("is-low", new Date(m.turn_deadline).getTime() - Date.now() < 60000);
    claim.hidden = mine || !expired;
  }
  online.timer = setInterval(tickClock, 1000);

  // subscribe to match row updates (state is written only by the server)
  var ch = CTX.client.channel("match-" + match.id)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "game_matches", filter: "id=eq." + match.id }, function (payload) {
      onlineUpdate(payload["new"]);
    })
    .subscribe(function (status) {
      // Catch up on anything that happened before the subscription was live,
      // and after a reconnect.
      if (status === "SUBSCRIBED") resyncOnline();
    });
  online.channel = ch;

  online.render = function () {
    var focusIndex = boardFocusIndex(board);
    paint();
    afterBoardRender(board, focusIndex);
  };
  function paint() {
    var st = online.state, m = online.match;
    board.innerHTML = "";
    over.hidden = true;
    resign.hidden = !(m.status === "active" || (m.status === "open" && online.seat === 0));
    resign.textContent = m.status === "open" ? "Cancel table" : "Resign";
    if (m.status === "open") { turnbar.textContent = waitMsg || "Waiting for a player to join…"; turnbar.className = "gturn opp"; mod.view(st, onlineApi(board, false)); return; }
    if (m.status !== "active") return finishOnline(m);
    if (mod.result(st)) {
      turnbar.textContent = "Settling the pot…"; turnbar.className = "gturn";
      mod.view(st, onlineApi(board, false));
      return;
    }
    tickClock();
    var yourTurn = (st.turn === online.seat) && !online.pending;
    turnbar.textContent = st.turn === online.seat ? "Your turn." : "Opponent's turn…";
    turnbar.className = "gturn " + (st.turn === online.seat ? "you" : "opp");
    mod.view(st, onlineApi(board, yourTurn));
  }
  online.render();
}

function onlineApi(board, yourTurn) {
  var mod = online.mod;
  var api = { board: board, canMove: yourTurn, oppName: online.seat === 0 ? "Guest" : "Host", online: true };
  // per-game scratch (checkers selection) persists on `online`
  Object.defineProperty(api, "_ck", { get: function () { return online._ck; }, set: function (v) { online._ck = v; } });
  Object.defineProperty(api, "_ce", { get: function () { return online._ce; }, set: function (v) { online._ce = v; } });
  api.rerender = online.render;
  api.move = function (m) {
    if (online.pending || online.state.turn !== online.seat) return;
    var match = online.match;
    // Optimistic: show the move now; the server's answer is authoritative.
    online.state = mod.apply(online.state, m);
    online.pending = true;
    online.render();
    sendToServer({ match_id: match.id, move: m, seq: match.move_seq })
      .then(function (row) {
        online.pending = false;
        if (row) onlineUpdate(row);
      })
      .catch(function (e) {
        online.pending = false;
        notify(e, "That move couldn't be played. The board has been refreshed.", "info");
        resyncOnline();
      });
  };
  return api;
}

function onlineUpdate(row) {
  if (!online || row.id !== online.match.id) return;
  // ignore stale realtime events that arrive after a newer server response
  if (row.move_seq < online.match.move_seq) return;
  online.match = row;
  online.state = authoritativeState(row, online.mod);
  if (row.status === "settled" && CTX.refreshWallet) CTX.refreshWallet();
  online.render();
}

function finishOnline(m) {
  var board = h("g-board"), turnbar = h("g-turn"), over = h("g-over");
  board.innerHTML = ""; online.mod.view(online.state, onlineApi(board, false));
  afterBoardRender(board, -1);
  turnbar.textContent = "";
  over.hidden = false;
  if (m.status === "cancelled") {
    over.innerHTML = '<h3>Match voided</h3><p>Both stakes were refunded to your wallets.</p>';
  } else if (m.status === "disputed") {
    over.innerHTML = '<h3>Result in dispute</h3><p>The pot is held until it\'s resolved.</p>';
  } else if (m.is_draw) {
    over.innerHTML = '<h3>Draw</h3><p>Both stakes were refunded to your wallets.</p>';
  } else {
    var won = m.winner_id === CTX.UID;
    over.innerHTML = '<h3 class="' + (won ? "win" : "lose") + '">' + (won ? "You win" : "You lose") + '</h3>' +
      '<p>' + (won ? "You took the pot: +" + rcoin(m.stake_cents * 2) + " rcoin (net +" + rcoin(m.stake_cents) + ")." : "The pot went to your opponent (−" + rcoin(m.stake_cents) + " rcoin).") + '</p>';
  }
  var acts = el("div", "gover__acts");
  var leave = el("button", "btn btn--cta", "Back to games"); leave.addEventListener("click", function () { stopOnline(); renderLobby(); });
  acts.appendChild(leave); over.appendChild(acts);
  leave.focus();
  if (CTX.refreshWallet) CTX.refreshWallet();
}
