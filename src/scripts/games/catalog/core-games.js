/* ============================================================================
 * Runinback — core games: tic-tac-toe, connect four, reversi, mancala,
 * checkers (stakeable; their rules live in supabase/functions/_shared/
 * game-rules) and crazy eights (practice only: shuffled deck, hidden hands).
 *
 * Each module is { id, name, icon, tag, blurb, init, legal, apply, result, bot,
 * view }. Rules (init/legal/apply/result/bot) are pure and DOM-free; only
 * view() touches the DOM, and only when called.
 * ========================================================================== */
import { el } from "../../lib/dom.js";
import TicTacToeRules from "@game-rules/tictactoe.js";
import Connect4Rules, { COLS, ROWS } from "@game-rules/connect4.js";
import ReversiRules from "@game-rules/reversi.js";
import MancalaRules from "@game-rules/mancala.js";
import CheckersRules from "@game-rules/checkers.js";
import { withView } from "./with-view.js";

function clone(o) { return JSON.parse(JSON.stringify(o)); }

/* =========================================================================
 * GAME MODULES
 * Seat 0 = you (host).  Seat 1 = opponent (guest / bot).  state.turn = 0|1.
 * result(state) -> null while playing, else { over:true, winner:0|1|null }
 *                  (winner null = draw).
 * ========================================================================= */

/* ---- Tic-Tac-Toe (perfect minimax bot) ---------------------------------- */
var TicTacToe = withView(TicTacToeRules, {
  view: function (s, api) {
    var g = el("div", "gg-ttt");
    for (var i = 0; i < 9; i++) (function (i) {
      var c = el("button", "gg-ttt__cell");
      c.disabled = !(api.canMove && s.b[i] == null);
      if (s.b[i] != null) { c.classList.add(s.b[i] === 0 ? "p0" : "p1"); c.textContent = s.b[i] === 0 ? "✕" : "◯"; }
      c.addEventListener("click", function () { api.move(i); });
      g.appendChild(c);
    })(i);
    api.board.appendChild(g);
  }
});

/* ---- Connect Four ------------------------------------------------------- */
var Connect4 = withView(Connect4Rules, {
  view: function (s, api) {
    var wrap = el("div", "gg-c4");
    for (var r = ROWS - 1; r >= 0; r--) for (var c = 0; c < COLS; c++) {
      var cell = el("div", "gg-c4__cell");
      var v = s.b[c][r];
      if (v != null) { cell.classList.add(v === 0 ? "p0" : "p1"); if (s.last && s.last.c === c && s.last.r === r) cell.classList.add("just"); }
      wrap.appendChild(cell);
    }
    var bar = el("div", "gg-c4__drop");
    for (var c2 = 0; c2 < COLS; c2++) (function (c2) {
      var b = el("button", "gg-c4__col", "▾");
      b.disabled = !(api.canMove && s.b[c2].length < ROWS);
      b.addEventListener("click", function () { api.move(c2); });
      bar.appendChild(b);
    })(c2);
    api.board.appendChild(bar);
    api.board.appendChild(wrap);
  }
});

/* ---- Reversi (Othello) -------------------------------------------------- */
var Reversi = withView(ReversiRules, {
  view: function (s, api) {
    var legalSet = {}; if (api.canMove) Reversi.legal(s).forEach(function (m) { legalSet[m] = 1; });
    var g = el("div", "gg-rev");
    for (var i = 0; i < 64; i++) (function (i) {
      var cell = el("button", "gg-rev__cell");
      if (s.b[i] != null) { var d = el("span", "gg-rev__disc " + (s.b[i] === 0 ? "p0" : "p1")); cell.appendChild(d); }
      else if (legalSet[i]) { cell.classList.add("ok"); cell.addEventListener("click", function () { api.move(i); }); }
      else { cell.disabled = true; }
      if (s.last === i) cell.classList.add("just");
      g.appendChild(cell);
    })(i);
    api.board.appendChild(g);
    var c = Reversi.count(s);
    var sc = el("div", "gg-rev__score");
    sc.innerHTML = '<span class="p0">You ' + c[0] + '</span><span class="p1">' + api.oppName + ' ' + c[1] + '</span>';
    api.board.appendChild(sc);
  }
});

/* ---- Mancala (Kalah, 6 pits, 4 seeds) ----------------------------------- */
// pits[0..5] you, pits[6] your store, pits[7..12] opp, pits[13] opp store.
var Mancala = withView(MancalaRules, {
  view: function (s, api) {
    var legalSet = {}; if (api.canMove) Mancala.legal(s).forEach(function (i) { legalSet[i] = 1; });
    var wrap = el("div", "gg-man");
    var oppStore = el("div", "gg-man__store", ""); oppStore.appendChild(pit(13, "store p1")); wrap.appendChild(oppStore);
    var mid = el("div", "gg-man__mid");
    var top = el("div", "gg-man__row");
    for (var i = 12; i >= 7; i--) top.appendChild(pit(i, "p1"));
    var bot = el("div", "gg-man__row");
    for (var j = 0; j <= 5; j++) bot.appendChild(pit(j, "p0"));
    mid.appendChild(top); mid.appendChild(bot); wrap.appendChild(mid);
    var myStore = el("div", "gg-man__store", ""); myStore.appendChild(pit(6, "store p0")); wrap.appendChild(myStore);
    api.board.appendChild(wrap);
    function pit(i, cls) {
      var b = el("button", "gg-man__pit " + cls);
      b.innerHTML = '<span class="v">' + s.p[i] + '</span>';
      if (legalSet[i]) { b.classList.add("ok"); b.addEventListener("click", function () { api.move(i); }); }
      else b.disabled = true;
      return b;
    }
  }
});

/* ---- Checkers (English draughts, forced captures, multi-jump) ------------ */
// board: 64 cells, null or {p:0|1, k:bool}. Player 0 moves up (row decreasing),
// player 1 moves down. Only dark squares used.
var Checkers = withView(CheckersRules, {
  view: function (s, api) {
    var legal = api.canMove ? Checkers.legal(s) : [];
    var fromSel = api._ck && api._ck.from != null ? api._ck.from : null;
    var movesByFrom = {}; legal.forEach(function (m) { (movesByFrom[m.from] = movesByFrom[m.from] || []).push(m); });
    var targets = {}; if (fromSel != null) (movesByFrom[fromSel] || []).forEach(function (m) { var t = m.caps && m.caps.length ? m.path[m.path.length - 1] : m.to; targets[t] = m; });
    var g = el("div", "gg-chk");
    for (var i = 0; i < 64; i++) (function (i) {
      var r = (i / 8) | 0, c = i % 8, dark = (r + c) % 2 === 1;
      var cell = el("button", "gg-chk__sq " + (dark ? "d" : "l"));
      cell.disabled = true;
      var pc = s.b[i];
      if (pc) { var d = el("span", "gg-chk__pc " + (pc.p === 0 ? "p0" : "p1") + (pc.k ? " king" : "")); if (pc.k) d.textContent = "♔"; cell.appendChild(d); }
      if (fromSel === i) cell.classList.add("sel");
      if (api.canMove && movesByFrom[i] && fromSel == null) { cell.disabled = false; cell.classList.add("movable"); cell.addEventListener("click", function () { api._ck = { from: i }; api.rerender(); }); }
      else if (fromSel != null && targets[i]) { cell.disabled = false; cell.classList.add("target"); cell.addEventListener("click", function () { var m = targets[i]; api._ck = null; api.move(m); }); }
      else if (fromSel === i) { cell.disabled = false; cell.addEventListener("click", function () { api._ck = null; api.rerender(); }); }
      g.appendChild(cell);
    })(i);
    api.board.appendChild(g);
    if (api.canMove) { var hint = el("p", "gg-hint", fromSel == null ? "Tap a piece, then its destination." + (legal.some(function (m) { return m.caps && m.caps.length; }) ? " A capture is available and must be taken." : "") : "Tap a highlighted square to move, or the piece again to cancel."); api.board.appendChild(hint); }
  }
});

/* ---- Crazy Eights (public-domain ancestor of UNO) ----------------------- */
var CE_COLORS = ["r", "y", "g", "b"], CE_CNAME = { r: "Red", y: "Yellow", g: "Green", b: "Blue" };
var CrazyEights = {
  id: "eights", name: "Crazy Eights", tag: "5 min", icon: "★",
  blurb: "Empty your hand first. Match color or number, or drop an eight.",
  _deck: function () {
    var d = [];
    CE_COLORS.forEach(function (c) { for (var n = 0; n <= 9; n++) { d.push({ c: c, v: n }); if (n !== 0) d.push({ c: c, v: n }); } });
    // add a handful of eights already covered above (value 8 x2 per color = wild)
    return CrazyEights._shuffle(d);
  },
  _shuffle: function (a) { for (var i = a.length - 1; i > 0; i--) { var j = (Math.random() * (i + 1)) | 0; var t = a[i]; a[i] = a[j]; a[j] = t; } return a; },
  init: function () {
    var d = CrazyEights._deck(), h0 = d.splice(0, 7), h1 = d.splice(0, 7), first;
    while (true) { first = d.shift(); if (first.v !== 8) break; d.push(first); }
    return { deck: d, hands: [h0, h1], discardTop: first, color: first.c, turn: 0, log: "" };
  },
  _playable: function (card, s) { return card.v === 8 || card.c === s.color || card.v === s.discardTop.v; },
  legal: function (s) {
    var moves = [], hand = s.hands[s.turn];
    for (var i = 0; i < hand.length; i++) if (CrazyEights._playable(hand[i], s)) {
      if (hand[i].v === 8) CE_COLORS.forEach(function (col) { moves.push({ t: "play", i: i, color: col }); });
      else moves.push({ t: "play", i: i });
    }
    moves.push({ t: "draw" });
    return moves;
  },
  apply: function (s, m) {
    var n = clone(s), hand = n.hands[n.turn];
    if (m.t === "draw") {
      if (!n.deck.length) CrazyEights._reshuffle(n);
      if (n.deck.length) hand.push(n.deck.shift());
      n.log = (n.turn === 0 ? "You draw" : "Rival draws") + " a card.";
      n.turn = n.turn ^ 1;
      return n;
    }
    var card = hand.splice(m.i, 1)[0];
    n.discardTop = card;
    n.color = card.v === 8 ? (m.color || card.c) : card.c;
    n.log = (n.turn === 0 ? "You play " : "Rival plays ") + CrazyEights._name(card, n.color);
    if (hand.length === 0) { n._winner = s.turn; return n; }
    n.turn = n.turn ^ 1;
    return n;
  },
  _reshuffle: function (n) { var top = n.discardTop; n.deck = CrazyEights._shuffle([]); /* discard pile not tracked; reuse nothing */ n.discardTop = top; },
  _name: function (card, color) { return card.v === 8 ? ("an 8 → " + CE_CNAME[color]) : (CE_CNAME[card.c] + " " + card.v); },
  result: function (s) {
    if (s._winner != null) return { over: true, winner: s._winner };
    // stall guard: deck empty and current player can only draw -> fewest cards wins
    if (s.deck.length === 0) {
      var canPlay = s.hands[s.turn].some(function (c) { return CrazyEights._playable(c, s); });
      if (!canPlay) {
        var a = s.hands[0].length, b = s.hands[1].length;
        return { over: true, winner: a === b ? null : (a < b ? 0 : 1) };
      }
    }
    return null;
  },
  bot: function (s) {
    var hand = s.hands[s.turn];
    var moves = CrazyEights.legal(s), plays = moves.filter(function (m) { return m.t === "play"; });
    if (!plays.length) return { t: "draw" };
    // prefer non-eights; choose eight color = most common in hand
    var non = plays.filter(function (m) { return hand[m.i].v !== 8; });
    if (non.length) return non[0];
    var cnt = { r: 0, y: 0, g: 0, b: 0 }; hand.forEach(function (c) { if (c.v !== 8) cnt[c.c]++; });
    var best = "r", mx = -1; CE_COLORS.forEach(function (c) { if (cnt[c] > mx) { mx = cnt[c]; best = c; } });
    var eight = plays.filter(function (m) { return hand[m.i].v === 8; })[0];
    return { t: "play", i: eight.i, color: best };
  },
  view: function (s, api) {
    var wrap = el("div", "gg-ce");
    // opponent
    var oppRow = el("div", "gg-ce__opp");
    oppRow.appendChild(el("span", "gg-ce__who", api.oppName + " · " + s.hands[1].length + " cards"));
    var oppCards = el("div", "gg-ce__fan");
    for (var k = 0; k < s.hands[1].length; k++) { var bk = el("div", "gg-ce__card back"); oppCards.appendChild(bk); }
    oppRow.appendChild(oppCards); wrap.appendChild(oppRow);
    // center
    var center = el("div", "gg-ce__center");
    var top = cardEl(s.discardTop, s.color);
    center.appendChild(top);
    var flag = el("div", "gg-ce__flag"); flag.innerHTML = 'In play · <b style="color:var(--card-' + s.color + ')">' + CE_CNAME[s.color] + '</b>'; center.appendChild(flag);
    var drawBtn = el("button", "gg-ce__card draw"); drawBtn.textContent = "＋"; drawBtn.title = "Draw a card";
    drawBtn.disabled = !api.canMove; drawBtn.addEventListener("click", function () { api.move({ t: "draw" }); });
    center.appendChild(drawBtn);
    wrap.appendChild(center);
    // your hand
    wrap.appendChild(el("div", "gg-ce__who", "You · " + s.hands[0].length + " cards"));
    var yourHand = el("div", "gg-ce__fan gg-ce__mine");
    var chosen = api._ce && api._ce.i;
    s.hands[0].forEach(function (card, i) {
      var c = cardEl(card, card.c);
      if (api.canMove && CrazyEights._playable(card, s)) {
        c.classList.add("playable");
        c.addEventListener("click", function () {
          if (card.v === 8) { api._ce = { i: i }; api.rerender(); }
          else api.move({ t: "play", i: i });
        });
      }
      yourHand.appendChild(c);
    });
    wrap.appendChild(yourHand);
    if (chosen != null) {
      var pick = el("div", "gg-ce__picker");
      pick.appendChild(el("span", "gg-hint", "Pick a color for your eight:"));
      CE_COLORS.forEach(function (col) { var sw = el("button", "gg-ce__swatch s-" + col); sw.title = CE_CNAME[col]; sw.addEventListener("click", function () { var i = api._ce.i; api._ce = null; api.move({ t: "play", i: i, color: col }); }); pick.appendChild(sw); });
      wrap.appendChild(pick);
    }
    if (s.log) wrap.appendChild(el("p", "gg-hint gg-ce__log", s.log));
    api.board.appendChild(wrap);
    function cardEl(card, color) {
      var e = el("div", "gg-ce__card c-" + color);
      e.appendChild(el("span", "v", card.v === 8 ? "8" : String(card.v)));
      return e;
    }
  }
};

export const CORE_GAMES = [TicTacToe, Connect4, Reversi, Mancala, Checkers, CrazyEights];
