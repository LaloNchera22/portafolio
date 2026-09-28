/* ============================================================================
 * Runinback — Games engine. Casual multiplayer games on the dashboard.
 *
 * Two ways to play every game:
 *   • Practice vs the house bot — free, offline, always available.
 *   • Play for rcoin — a staked 1v1 over Supabase Realtime. Both players stake
 *     the same amount, the winner takes the whole pot (no rake: the 5% is
 *     charged once when you buy rcoin, never on the table). Board state syncs
 *     over Realtime; the payout is settled server-side only when both players
 *     report the same result, so no one can pay themselves.
 *
 * Game rules live in ./catalog (one module per game: init/legal/apply/result/
 * bot/view). This engine runs the lobby, the turn loop, the bot, the result
 * screen and (online) the sync.
 * ========================================================================== */
import { el, escapeHtml as esc } from "../lib/dom.js";
import { centsToRcoin as rcoin } from "../lib/format.js";
import { notify } from "../lib/errors.js";
import { CORE_GAMES } from "./catalog/core-games.js";
import { EXTRA_GAMES } from "./catalog/extra-games.js";
import { COMING_SOON_GAMES, isStakeable } from "./catalog/catalog-meta.js";
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
  var x = el("button", "ghelp__x", "✕"); x.setAttribute("aria-label", "Close");
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
  function close() { if (back.parentNode) back.parentNode.removeChild(back); document.removeEventListener("keydown", onKey); }
  function onKey(e) { if (e.key === "Escape") close(); }
  x.addEventListener("click", close);
  ok.addEventListener("click", close);
  back.addEventListener("click", function (e) { if (e.target === back) close(); });
  document.addEventListener("keydown", onKey);
  // Mount inside the .capp shell: the overlay's styles (fixed positioning,
  // backdrop, panel) and the color variables all live under .capp, so
  // appending to document.body would leave it unstyled — a raw block of
  // text dumped at the foot of the page instead of a centered modal.
  var root = (host && host.closest && host.closest(".capp")) || document.querySelector(".capp") || document.body;
  root.appendChild(back);
}

export function initGames(ctx) {
  CTX = ctx || {};
  host = h("games-root");
  if (!host) return;
  renderLobby();
}

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

  function close() { if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop); document.removeEventListener("keydown", onKey); }
  function onKey(e) { if (e.key === "Escape") close(); }
  // launch a mode: dismiss the pop-up, then render the game's sub-page
  function launch(fn) { close(); fn(); }

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
  var x = el("button", "gplay__x", "✕"); x.setAttribute("aria-label", "Close");
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
  // the active stake: a typed custom amount wins, else the selected chip, else 1
  function currentStake() {
    var c = parseInt(custom.value, 10);
    if (custom.value !== "" && c >= 1) return c;
    var on = stakeRow.querySelector("button.on");
    return on ? parseInt(on.getAttribute("data-r"), 10) : 1;
  }
  function setPot() { var r = currentStake(); pot.innerHTML = 'Winner takes <b>' + (r * 2) + ' rcoin</b>'; }
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
  var cBtn = el("button", "btn gplay__act", "Create table");
  cBtn.addEventListener("click", function () {
    var r = currentStake();
    launch(function () { createOnline(gameId, r * 100, cBtn); });
  });
  coinR.appendChild(cBtn);
  var note = el("p", "gplay__note");
  coinR.appendChild(note);
  if (!CTX.configured) { cBtn.disabled = true; note.textContent = "Staked tables open once the backend is connected. Practice works now."; }
  else if (!isStakeable(gameId)) { cBtn.disabled = true; note.textContent = "Staked tables for this game are coming soon. Practice works now."; }
  coin.appendChild(coinR);
  panel.appendChild(coin);

  backdrop.appendChild(panel);
  backdrop.addEventListener("click", function (e) { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", onKey);
  var root = (host && host.closest && host.closest(".capp")) || document.querySelector(".capp") || document.body;
  root.appendChild(backdrop);
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
  var board = el("div", "gboard"); board.id = "g-board";
  var over = el("div", "gover"); over.id = "g-over"; over.hidden = true;
  stageWrap.appendChild(turnbar); stageWrap.appendChild(board); stageWrap.appendChild(over);
  host.appendChild(stageWrap);

  api.oppName = "Bot";
  function draw() {
    board.innerHTML = "";
    var res = mod.result(state);
    api.canMove = !res && state.turn === 0;
    mod.view(state, apiFor(board));
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
    turnbar.textContent = "";
    over.hidden = false;
    var won = res.winner === 0, draw2 = res.winner == null;
    over.innerHTML = '<h3 class="' + (draw2 ? "" : (won ? "win" : "lose")) + '">' + (draw2 ? "Draw" : (won ? "You win" : "Bot wins")) + '</h3>' +
      '<p>Practice round — no rcoin at stake.</p>';
    var acts = el("div", "gover__acts");
    var again = el("button", "btn btn--cta", "Play again"); again.addEventListener("click", function () { startPractice(gameId); });
    var leave = el("button", "btn", "All games"); leave.addEventListener("click", renderLobby);
    acts.appendChild(again); acts.appendChild(leave); over.appendChild(acts);
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
  online = null;
}

function loadOpenTables() {
  var box = h("games-open"); if (!box) return;
  if (!CTX.configured) { box.innerHTML = ""; return; }
  CTX.client.from("game_matches").select("id, game, stake_cents, host_id, created_at").eq("status", "open").neq("host_id", CTX.UID).order("created_at", { ascending: false }).limit(20)
    .then(function (r) {
      var rows = (r.data) || [];
      if (r.error || !rows.length) { box.innerHTML = ""; return; }
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
    .catch(function () { btn.disabled = false; });
}

function joinOnline(match, btn) {
  if (!CTX.configured) return;
  var mod = MODULES[match.game]; if (!mod) return;
  btn.disabled = true;
  CTX.client.rpc("rib_game_join", { p_match_id: match.id, p_state: null })
    .then(function (r) {
      if (r.error) { notify(r.error, "We couldn't join this table. Please try again."); btn.disabled = false; return; }
      if (CTX.refreshWallet) CTX.refreshWallet();
      enterOnline(r.data, mod, 1, null);
    })
    .catch(function () { btn.disabled = false; });
}

// Every staked move goes through the game-move Edge Function, which validates
// it with the shared rules and settles the pot when the game ends.
function sendToServer(body) {
  return CTX.client.functions.invoke("game-move", { body: body }).then(function (r) {
    if (!r.error) return r.data && r.data.match;
    var ctx = r.error.context;
    var parse = ctx && typeof ctx.json === "function" ? ctx.json().catch(function () { return {}; }) : Promise.resolve({});
    return parse.then(function (payload) {
      var err = new Error((payload && payload.error) || "move_failed");
      err.hint = payload && payload.error;
      throw err;
    });
  });
}

function resyncOnline() {
  if (!online) return;
  CTX.client.from("game_matches").select("*").eq("id", online.match.id).single()
    .then(function (r) { if (!r.error && r.data) onlineUpdate(r.data); });
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
    if (!online || online.match.status !== "active") return;
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
  var board = el("div", "gboard"); board.id = "g-board";
  var over = el("div", "gover"); over.id = "g-over"; over.hidden = true;
  stageWrap.appendChild(turnbar); stageWrap.appendChild(board); stageWrap.appendChild(over);
  host.appendChild(stageWrap);

  // subscribe to match row updates (state is written only by the server)
  var ch = CTX.client.channel("match-" + match.id)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "game_matches", filter: "id=eq." + match.id }, function (payload) {
      onlineUpdate(payload["new"]);
    })
    .subscribe();
  online.channel = ch;

  online.render = function () {
    var st = online.state, m = online.match;
    board.innerHTML = "";
    over.hidden = true;
    resign.hidden = m.status !== "active";
    if (m.status === "open") { turnbar.textContent = waitMsg || "Waiting for a player to join…"; turnbar.className = "gturn opp"; mod.view(st, onlineApi(board, false)); return; }
    if (m.status !== "active") return finishOnline(m);
    if (mod.result(st)) {
      turnbar.textContent = "Settling the pot…"; turnbar.className = "gturn";
      mod.view(st, onlineApi(board, false));
      return;
    }
    var yourTurn = (st.turn === online.seat) && !online.pending;
    turnbar.textContent = st.turn === online.seat ? "Your turn." : "Opponent's turn…";
    turnbar.className = "gturn " + (st.turn === online.seat ? "you" : "opp");
    mod.view(st, onlineApi(board, yourTurn));
  };
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
  if (CTX.refreshWallet) CTX.refreshWallet();
}
