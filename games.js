/* ============================================================================
 * Runinback — Games. Casual multiplayer games on the dashboard.
 *
 * Two ways to play every game:
 *   • Practice vs the house bot — free, offline, always available.
 *   • Play for rcoin — a staked 1v1 over Supabase Realtime. Both players stake
 *     the same amount, the winner takes the whole pot (no rake: the 5% is
 *     charged once when you buy rcoin, never on the table). Board state syncs
 *     over Realtime; the payout is settled server-side only when both players
 *     report the same result, so no one can pay themselves.
 *
 * Each game is a small module: init/legal/apply/result/bot/view. The driver
 * runs the turn loop, the bot, the result screen and (online) the sync.
 * ========================================================================== */
window.RIBGames = (function () {
  "use strict";

  /* ---- tiny helpers ------------------------------------------------------- */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function money(cents) { return "$" + ((Number(cents) || 0) / 100).toFixed(2); }
  function rcoin(cents) { return Math.round((Number(cents) || 0) / 100); }

  /* =========================================================================
   * GAME MODULES
   * Seat 0 = you (host).  Seat 1 = opponent (guest / bot).  state.turn = 0|1.
   * result(state) -> null while playing, else { over:true, winner:0|1|null }
   *                  (winner null = draw).
   * ========================================================================= */

  /* ---- Tic-Tac-Toe (perfect minimax bot) ---------------------------------- */
  var TicTacToe = {
    id: "tictactoe", name: "Tic-Tac-Toe", tag: "1 min", icon: "╳",
    blurb: "The quickest warmup. Get three in a row before your rival.",
    init: function () { return { b: [null, null, null, null, null, null, null, null, null], turn: 0 }; },
    legal: function (s) { var m = []; for (var i = 0; i < 9; i++) if (s.b[i] == null) m.push(i); return m; },
    apply: function (s, i) { var nb = s.b.slice(); nb[i] = s.turn; return { b: nb, turn: s.turn ^ 1 }; },
    result: function (s) {
      var L = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
      for (var k = 0; k < L.length; k++) { var a = L[k]; if (s.b[a[0]] != null && s.b[a[0]] === s.b[a[1]] && s.b[a[1]] === s.b[a[2]]) return { over: true, winner: s.b[a[0]] }; }
      return s.b.every(function (x) { return x != null; }) ? { over: true, winner: null } : null;
    },
    bot: function (s) {
      var me = s.turn;
      function mm(st, depth) {
        var r = TicTacToe.result(st);
        if (r) { if (r.winner === me) return 10 - depth; if (r.winner == null) return 0; return depth - 10; }
        var moves = TicTacToe.legal(st), best = st.turn === me ? -1e9 : 1e9;
        for (var i = 0; i < moves.length; i++) { var v = mm(TicTacToe.apply(st, moves[i]), depth + 1); best = st.turn === me ? Math.max(best, v) : Math.min(best, v); }
        return best;
      }
      var moves = TicTacToe.legal(s), bestMove = moves[0], bestVal = -1e9;
      for (var i = 0; i < moves.length; i++) { var v = mm(TicTacToe.apply(s, moves[i]), 0); if (v > bestVal) { bestVal = v; bestMove = moves[i]; } }
      return bestMove;
    },
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
  };

  /* ---- Connect Four ------------------------------------------------------- */
  var COLS = 7, ROWS = 6;
  var Connect4 = {
    id: "connect4", name: "Connect Four", tag: "2 min", icon: "●",
    blurb: "Drop discs and line up four before your opponent does.",
    init: function () { var b = []; for (var c = 0; c < COLS; c++) b.push([]); return { b: b, turn: 0, last: null }; },
    legal: function (s) { var m = []; for (var c = 0; c < COLS; c++) if (s.b[c].length < ROWS) m.push(c); return m; },
    apply: function (s, c) { var n = clone(s); n.b[c].push(s.turn); n.last = { c: c, r: n.b[c].length - 1, p: s.turn }; n.turn = s.turn ^ 1; return n; },
    _at: function (b, c, r) { return (c < 0 || c >= COLS || r < 0 || r >= ROWS) ? null : (b[c][r] == null ? null : b[c][r]); },
    result: function (s) {
      var dirs = [[1,0],[0,1],[1,1],[1,-1]];
      for (var c = 0; c < COLS; c++) for (var r = 0; r < ROWS; r++) {
        var v = Connect4._at(s.b, c, r); if (v == null) continue;
        for (var d = 0; d < dirs.length; d++) {
          var ok = true;
          for (var k = 1; k < 4; k++) if (Connect4._at(s.b, c + dirs[d][0] * k, r + dirs[d][1] * k) !== v) { ok = false; break; }
          if (ok) return { over: true, winner: v };
        }
      }
      return Connect4.legal(s).length === 0 ? { over: true, winner: null } : null;
    },
    bot: function (s) {
      var me = s.turn, opp = me ^ 1, legal = Connect4.legal(s);
      for (var i = 0; i < legal.length; i++) { var r = Connect4.result(Connect4.apply(s, legal[i])); if (r && r.winner === me) return legal[i]; }
      for (var j = 0; j < legal.length; j++) { var t = clone(s); t.turn = opp; var r2 = Connect4.result(Connect4.apply(t, legal[j])); if (r2 && r2.winner === opp) return legal[j]; }
      var order = [3, 2, 4, 1, 5, 0, 6];
      for (var o = 0; o < order.length; o++) if (legal.indexOf(order[o]) >= 0) return order[o];
      return legal[0];
    },
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
  };

  /* ---- Reversi (Othello) -------------------------------------------------- */
  var Reversi = {
    id: "reversi", name: "Reversi", tag: "5 min", icon: "◑",
    blurb: "Flank your rival's discs to flip them. Most discs at the end wins.",
    init: function () {
      var b = []; for (var i = 0; i < 64; i++) b.push(null);
      b[27] = 1; b[28] = 0; b[35] = 0; b[36] = 1;
      return { b: b, turn: 0, last: null };
    },
    _flips: function (b, idx, me) {
      var x = idx % 8, y = (idx / 8) | 0, opp = me ^ 1, out = [];
      var D = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      for (var d = 0; d < 8; d++) {
        var cx = x + D[d][0], cy = y + D[d][1], line = [];
        while (cx >= 0 && cx < 8 && cy >= 0 && cy < 8) {
          var ci = cy * 8 + cx, v = b[ci];
          if (v === opp) { line.push(ci); cx += D[d][0]; cy += D[d][1]; }
          else if (v === me) { out = out.concat(line); break; }
          else break;
        }
      }
      return out;
    },
    legal: function (s) { var m = []; for (var i = 0; i < 64; i++) if (s.b[i] == null && Reversi._flips(s.b, i, s.turn).length) m.push(i); return m; },
    apply: function (s, idx) {
      var n = clone(s), fl = Reversi._flips(s.b, idx, s.turn);
      n.b[idx] = s.turn; for (var k = 0; k < fl.length; k++) n.b[fl[k]] = s.turn; n.last = idx;
      n.turn = s.turn ^ 1;
      if (!Reversi.legal(n).length) { n.turn = n.turn ^ 1; n.passed = !Reversi.legal(n).length; }
      return n;
    },
    result: function (s) {
      var meMoves = Reversi.legal(s).length; if (meMoves) return null;
      var alt = clone(s); alt.turn = s.turn ^ 1; if (Reversi.legal(alt).length) return null;
      var c0 = 0, c1 = 0; for (var i = 0; i < 64; i++) { if (s.b[i] === 0) c0++; else if (s.b[i] === 1) c1++; }
      return { over: true, winner: c0 === c1 ? null : (c0 > c1 ? 0 : 1) };
    },
    bot: function (s) {
      var legal = Reversi.legal(s), corners = [0, 7, 56, 63];
      var best = legal[0], bestScore = -1e9;
      for (var i = 0; i < legal.length; i++) {
        var m = legal[i], sc = Reversi._flips(s.b, m, s.turn).length;
        if (corners.indexOf(m) >= 0) sc += 20;
        if ([1,6,8,9,14,15,48,49,54,55,57,62].indexOf(m) >= 0) sc -= 5; // squares next to corners
        if (sc > bestScore) { bestScore = sc; best = m; }
      }
      return best;
    },
    count: function (s) { var c0 = 0, c1 = 0; for (var i = 0; i < 64; i++) { if (s.b[i] === 0) c0++; else if (s.b[i] === 1) c1++; } return [c0, c1]; },
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
  };

  /* ---- Mancala (Kalah, 6 pits, 4 seeds) ----------------------------------- */
  // pits[0..5] you, pits[6] your store, pits[7..12] opp, pits[13] opp store.
  var Mancala = {
    id: "mancala", name: "Mancala", tag: "5 min", icon: "◔",
    blurb: "Sow your seeds, land in your store for another turn, capture across.",
    init: function () { var p = [4,4,4,4,4,4,0,4,4,4,4,4,4,0]; return { p: p, turn: 0 }; },
    _mine: function (t) { return t === 0 ? [0,1,2,3,4,5] : [7,8,9,10,11,12]; },
    _store: function (t) { return t === 0 ? 6 : 13; },
    legal: function (s) { return Mancala._mine(s.turn).filter(function (i) { return s.p[i] > 0; }); },
    apply: function (s, i) {
      var n = clone(s), seeds = n.p[i], idx = i, me = s.turn, myStore = Mancala._store(me), oppStore = Mancala._store(me ^ 1);
      n.p[i] = 0;
      while (seeds > 0) { idx = (idx + 1) % 14; if (idx === oppStore) continue; n.p[idx]++; seeds--; }
      // capture: last seed in own empty pit, opposite has seeds
      var myPits = Mancala._mine(me);
      if (myPits.indexOf(idx) >= 0 && n.p[idx] === 1) {
        var opposite = 12 - idx; // mirror across the board (0<->12, 5<->7)
        if (n.p[opposite] > 0) { n.p[myStore] += n.p[opposite] + 1; n.p[opposite] = 0; n.p[idx] = 0; }
      }
      // extra turn if last seed landed in own store
      if (idx !== myStore) n.turn = me ^ 1;
      Mancala._sweepIfDone(n);
      return n;
    },
    _sweepIfDone: function (n) {
      var side0 = [0,1,2,3,4,5].every(function (i) { return n.p[i] === 0; });
      var side1 = [7,8,9,10,11,12].every(function (i) { return n.p[i] === 0; });
      if (side0 || side1) {
        for (var i = 0; i < 6; i++) { n.p[6] += n.p[i]; n.p[i] = 0; }
        for (var j = 7; j < 13; j++) { n.p[13] += n.p[j]; n.p[j] = 0; }
        n.done = true;
      }
    },
    result: function (s) {
      if (!s.done) return null;
      return { over: true, winner: s.p[6] === s.p[13] ? null : (s.p[6] > s.p[13] ? 0 : 1) };
    },
    bot: function (s) {
      var legal = Mancala.legal(s), me = s.turn, myStore = Mancala._store(me), best = legal[0], bestSc = -1e9;
      for (var i = 0; i < legal.length; i++) {
        var n = Mancala.apply(s, legal[i]), sc = n.p[myStore] - s.p[myStore];
        if (n.turn === me && !n.done) sc += 3; // earned an extra turn
        if (sc > bestSc) { bestSc = sc; best = legal[i]; }
      }
      return best;
    },
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
  };

  /* ---- Checkers (English draughts, forced captures, multi-jump) ------------ */
  // board: 64 cells, null or {p:0|1, k:bool}. Player 0 moves up (row decreasing),
  // player 1 moves down. Only dark squares used.
  var Checkers = {
    id: "checkers", name: "Checkers", tag: "10 min", icon: "◆",
    blurb: "Jump your rival's pieces, crown your kings, take the board.",
    init: function () {
      var b = []; for (var i = 0; i < 64; i++) b.push(null);
      for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) {
        if ((r + c) % 2 === 1) { if (r < 3) b[r*8+c] = { p: 1, k: false }; else if (r > 4) b[r*8+c] = { p: 0, k: false }; }
      }
      return { b: b, turn: 0, noProg: 0 };
    },
    _dirs: function (pc) { return pc.k ? [[-1,-1],[-1,1],[1,-1],[1,1]] : (pc.p === 0 ? [[-1,-1],[-1,1]] : [[1,-1],[1,1]]); },
    _capsFrom: function (b, idx) {
      // returns list of full jump paths [{path:[idx...], caps:[idx...]}] (maximal)
      var pc = b[idx]; if (!pc) return [];
      var results = [];
      function rec(board, at, caps, path) {
        var piece = board[at], moved = false;
        var dirs = Checkers._dirs(piece), r = (at / 8) | 0, c = at % 8;
        for (var d = 0; d < dirs.length; d++) {
          var mr = r + dirs[d][0], mc = c + dirs[d][1], lr = r + dirs[d][0] * 2, lc = c + dirs[d][1] * 2;
          if (lr < 0 || lr > 7 || lc < 0 || lc > 7) continue;
          var mid = mr * 8 + mc, land = lr * 8 + lc;
          if (board[mid] && board[mid].p !== piece.p && !board[land] && caps.indexOf(mid) < 0) {
            var nb = board.slice(); var np = { p: piece.p, k: piece.k };
            // promotion mid-jump ends the move in standard rules; keep king status if reached back row
            if (!np.k && ((np.p === 0 && lr === 0) || (np.p === 1 && lr === 7))) np.k = true;
            nb[at] = null; nb[mid] = null; nb[land] = np;
            moved = true;
            var promotedNow = np.k && !piece.k;
            if (promotedNow) results.push({ path: path.concat([land]), caps: caps.concat([mid]) });
            else rec(nb, land, caps.concat([mid]), path.concat([land]));
          }
        }
        if (!moved && caps.length) results.push({ path: path, caps: caps });
      }
      rec(b.slice(), idx, [], [idx]);
      // keep only maximal-length capture sequences from this square
      var maxLen = 0; results.forEach(function (r) { if (r.caps.length > maxLen) maxLen = r.caps.length; });
      return results.filter(function (r) { return r.caps.length === maxLen && maxLen > 0; });
    },
    legal: function (s) {
      var caps = [], simple = [];
      for (var i = 0; i < 64; i++) { var pc = s.b[i]; if (pc && pc.p === s.turn) { var cf = Checkers._capsFrom(s.b, i); for (var k = 0; k < cf.length; k++) caps.push({ from: i, path: cf[k].path, caps: cf[k].caps }); } }
      if (caps.length) return caps; // forced capture
      for (var j = 0; j < 64; j++) { var p2 = s.b[j]; if (p2 && p2.p === s.turn) {
        var dirs = Checkers._dirs(p2), r = (j / 8) | 0, c = j % 8;
        for (var d = 0; d < dirs.length; d++) { var nr = r + dirs[d][0], nc = c + dirs[d][1]; if (nr>=0&&nr<8&&nc>=0&&nc<8) { var t = nr*8+nc; if (!s.b[t]) simple.push({ from: j, to: t }); } }
      } }
      return simple;
    },
    apply: function (s, m) {
      var n = clone(s), pc = n.b[m.from];
      var wasMan = !s.b[m.from].k, isCap = !!(m.caps && m.caps.length);
      n.noProg = (isCap || wasMan) ? 0 : ((s.noProg || 0) + 1);   // 40-move-rule style draw guard
      if (m.caps && m.caps.length) {
        n.b[m.from] = null; var last = m.path[m.path.length - 1];
        for (var k = 0; k < m.caps.length; k++) n.b[m.caps[k]] = null;
        var lr = (last / 8) | 0;
        if (!pc.k && ((pc.p === 0 && lr === 0) || (pc.p === 1 && lr === 7))) pc.k = true;
        n.b[last] = pc;
      } else {
        n.b[m.from] = null; var tr = (m.to / 8) | 0;
        if (!pc.k && ((pc.p === 0 && tr === 0) || (pc.p === 1 && tr === 7))) pc.k = true;
        n.b[m.to] = pc;
      }
      n.turn = s.turn ^ 1;
      return n;
    },
    result: function (s) {
      if ((s.noProg || 0) >= 60) return { over: true, winner: null }; // 30 moves each with no capture/advance = draw
      var hasPiece = [false, false];
      for (var i = 0; i < 64; i++) if (s.b[i]) hasPiece[s.b[i].p] = true;
      if (!hasPiece[0]) return { over: true, winner: 1 };
      if (!hasPiece[1]) return { over: true, winner: 0 };
      if (!Checkers.legal(s).length) return { over: true, winner: s.turn ^ 1 }; // no moves = loss
      return null;
    },
    bot: function (s) {
      var legal = Checkers.legal(s);
      // prefer the longest capture; then advance / king safely
      var caps = legal.filter(function (m) { return m.caps && m.caps.length; });
      if (caps.length) { caps.sort(function (a, b) { return b.caps.length - a.caps.length; }); return caps[0]; }
      var best = legal[0], bestSc = -1e9;
      for (var i = 0; i < legal.length; i++) {
        var m = legal[i], to = m.to, tr = (to / 8) | 0, sc = 0, pc = s.b[m.from];
        if (pc.p === 1) sc += tr; else sc += (7 - tr);        // advance toward promotion
        if (!pc.k && ((pc.p === 0 && tr === 0) || (pc.p === 1 && tr === 7))) sc += 5;
        var next = Checkers.apply(s, m);                       // avoid handing an immediate capture
        if (Checkers.legal(next).some(function (x) { return x.caps && x.caps.length; })) sc -= 4;
        sc += Math.random();
        if (sc > bestSc) { bestSc = sc; best = m; }
      }
      return best;
    },
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
  };

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
      if (hand.length === 0) { n.turn = n.turn; n._winner = (s.turn); return n; }
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

  var MODULES = { tictactoe: TicTacToe, connect4: Connect4, reversi: Reversi, mancala: Mancala, checkers: Checkers, eights: CrazyEights };

  // Catalog order + "coming soon" entries (from Plato's real line-up).
  var CATALOG = [
    TicTacToe, Connect4, Reversi, Mancala, Checkers, CrazyEights
  ];
  var COMING_SOON = [
    { id: "chess", name: "Chess", tag: "soon", icon: "♞", blurb: "The classic. Ranked matches and stakes.", soon: true },
    { id: "ludo", name: "Ludo", tag: "soon", icon: "⚁", blurb: "Race all four tokens home. 2 to 4 players.", soon: true },
    { id: "backgammon", name: "Backgammon", tag: "soon", icon: "⛃", blurb: "Roll, race and bear off before your rival.", soon: true },
    { id: "spades", name: "Spades", tag: "soon", icon: "♠", blurb: "Bid your tricks and hit your target as a team.", soon: true },
    { id: "hearts", name: "Hearts", tag: "soon", icon: "♥", blurb: "Dodge the hearts and the queen of spades.", soon: true },
    { id: "poker", name: "Poker", tag: "soon", icon: "♣", blurb: "Heads-up hold'em tables.", soon: true }
  ];

  // Extra games register themselves (see games-extra.js), inserted before the
  // coming-soon block. Call once all modules are defined.
  function register(mod) { MODULES[mod.id] = mod; CATALOG.push(mod); }
  function finishCatalog() { for (var i = 0; i < COMING_SOON.length; i++) CATALOG.push(COMING_SOON[i]); }

  /* =========================================================================
   * DRIVER — runs a single game (practice vs bot, or online for rcoin).
   * ========================================================================= */
  var CTX = null;   // { client, UID, refreshWallet, configured }
  var host = null;  // container element for the games page

  function h(id) { return document.getElementById(id); }

  /* ---- how-to-play overlay ------------------------------------------------ */
  var HELP = {};   // filled by games-help.js (RIBGames.HELP)
  function getHelp(id) { return (window.RIBGames && window.RIBGames.HELP && window.RIBGames.HELP[id]) || HELP[id] || null; }

  function seenKey(id) { return "rib_game_seen_" + id; }
  function firstTime(id) { try { if (localStorage.getItem(seenKey(id))) return false; localStorage.setItem(seenKey(id), "1"); return true; } catch (e) { return false; } }

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
    document.body.appendChild(back);
  }

  function init(ctx) {
    CTX = ctx || {};
    host = h("games-root");
    if (!host) return;
    renderLobby();
  }

  /* ---- lobby -------------------------------------------------------------- */
  function renderLobby() {
    stopOnline();
    host.innerHTML = "";
    var intro = el("p", "games-intro");
    intro.innerHTML = "Play a quick match. Practice free against the house bot, or play for rcoin: both players stake the same, the winner takes the whole pot. No rake on the table — the 5% is charged once when you buy rcoin.";
    host.appendChild(intro);

    var grid = el("div", "games-grid");
    CATALOG.forEach(function (g) {
      var card = el("div", "gcard" + (g.soon ? " gcard--soon" : ""));
      card.innerHTML =
        '<div class="gcard__ic">' + esc(g.icon) + '</div>' +
        '<div class="gcard__n">' + esc(g.name) + '</div>' +
        '<p class="gcard__d">' + esc(g.blurb) + '</p>';
      var foot = el("div", "gcard__foot");
      if (g.soon) {
        var soon = el("button", "soon", "Coming soon");
        soon.title = "Preview";
        soon.addEventListener("click", function () { showHelp(g.id); });
        foot.appendChild(soon);
      }
      else {
        var left = el("div", "gcard__left");
        var play = el("button", "btn btn--sm gcard__play", "Play");
        play.addEventListener("click", function () { openGame(g.id); });
        left.appendChild(play);
        left.appendChild(helpButton(g.id));
        foot.appendChild(left);
        foot.appendChild(el("span", "gcard__tag", g.tag));
      }
      card.appendChild(foot);
      grid.appendChild(card);
    });
    host.appendChild(grid);

    // open online tables (if backend live)
    var openWrap = el("div", "games-open");
    openWrap.id = "games-open";
    host.appendChild(openWrap);
    loadOpenTables();
  }

  /* ---- a game screen (mode chooser) --------------------------------------- */
  function openGame(gameId) {
    stopOnline();
    var mod = MODULES[gameId];
    host.innerHTML = "";
    var top = el("div", "gscreen__top");
    var back = el("button", "btn btn--sm", "‹ All games");
    back.addEventListener("click", renderLobby);
    top.appendChild(back);
    top.appendChild(el("h2", "gscreen__name", mod.name));
    var how = el("button", "btn btn--sm gscreen__how", "How to play");
    how.addEventListener("click", function () { showHelp(gameId); });
    top.appendChild(how);
    host.appendChild(top);

    var choose = el("div", "gchoose");
    var practice = el("div", "gchoose__card");
    practice.innerHTML = '<h3>Practice</h3><p>Free warmup against the house bot. No stake.</p>';
    var pBtn = el("button", "btn btn--cta btn--wide", "Practice vs bot");
    pBtn.addEventListener("click", function () { startPractice(gameId); });
    practice.appendChild(pBtn);
    choose.appendChild(practice);

    var forCoin = el("div", "gchoose__card");
    forCoin.innerHTML = '<h3>Play for rcoin</h3><p>Stake rcoin, winner takes the full pot. No rake on the table.</p>';
    var stakeRow = el("div", "chips gchoose__chips");
    [25, 50, 100, 250].forEach(function (r, i) {
      var b = el("button", i === 1 ? "on" : "", String(r));
      b.setAttribute("data-r", r);
      b.addEventListener("click", function () { stakeRow.querySelectorAll("button").forEach(function (x) { x.classList.remove("on"); }); b.classList.add("on"); });
      stakeRow.appendChild(b);
    });
    forCoin.appendChild(el("label", "gchoose__lbl", "Stake (rcoin)"));
    forCoin.appendChild(stakeRow);
    var cBtn = el("button", "btn btn--wide", "Create table");
    cBtn.addEventListener("click", function () {
      var on = stakeRow.querySelector("button.on"); var r = on ? parseInt(on.getAttribute("data-r"), 10) : 50;
      createOnline(gameId, r * 100, cBtn);
    });
    forCoin.appendChild(cBtn);
    var note = el("p", "gchoose__note");
    forCoin.appendChild(note);
    if (!CTX.configured) { cBtn.disabled = true; note.textContent = "Connect the backend to play staked matches. Practice works now."; }
    choose.appendChild(forCoin);

    host.appendChild(choose);

    // show the rules automatically the first time you open this game
    if (firstTime(gameId)) showHelp(gameId);
  }

  /* ---- practice loop (seat 0 = you, seat 1 = bot) ------------------------- */
  function startPractice(gameId) {
    var mod = MODULES[gameId];
    var state = mod.init();
    var api = makeApi(mod, function () { return state; }, { online: false });
    host.innerHTML = "";
    var top = el("div", "gscreen__top");
    var back = el("button", "btn btn--sm", "‹ Leave");
    back.addEventListener("click", function () { openGame(gameId); });
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
      var leave = el("button", "btn", "Back"); leave.addEventListener("click", function () { openGame(gameId); });
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
          var row = el("div", "row row--reto");
          row.innerHTML = '<div><div class="row__name">' + esc(mod.name) + ' · ' + rcoin(m.stake_cents) + ' rcoin</div><div class="row__meta">pot ' + rcoin(m.stake_cents * 2) + ' rcoin · winner takes all</div></div>';
          var act = el("div", "row__act");
          var join = el("button", "btn btn--cta btn--sm", "Join for " + rcoin(m.stake_cents) + " rcoin");
          join.addEventListener("click", function () { joinOnline(m, join); });
          act.appendChild(join); row.appendChild(act); panel.appendChild(row);
        });
        box.appendChild(panel);
      });
  }

  function createOnline(gameId, stakeCents, btn) {
    if (!CTX.configured) return;
    var mod = MODULES[gameId];
    var state = mod.init();
    btn.disabled = true;
    CTX.client.rpc("rib_game_create", { p_game: gameId, p_stake_cents: stakeCents, p_state: state })
      .then(function (r) {
        if (r.error) { alert(r.error.message || "Could not create the table."); btn.disabled = false; return; }
        if (CTX.refreshWallet) CTX.refreshWallet();
        enterOnline(r.data, mod, 0, state, "Waiting for a player to join…");
      })
      .catch(function () { btn.disabled = false; });
  }

  function joinOnline(match, btn) {
    if (!CTX.configured) return;
    var mod = MODULES[match.game]; if (!mod) return;
    btn.disabled = true;
    CTX.client.rpc("rib_game_join", { p_match_id: match.id, p_state: null })
      .then(function (r) {
        if (r.error) { alert(r.error.message || "Could not join."); btn.disabled = false; return; }
        if (CTX.refreshWallet) CTX.refreshWallet();
        var m = r.data;
        enterOnline(m, mod, 1, m.state, null);
      })
      .catch(function () { btn.disabled = false; });
  }

  function enterOnline(match, mod, seat, state, waitMsg) {
    stopOnline();
    online = { match: match, mod: mod, seat: seat, state: state, channel: null, reported: false };
    host.innerHTML = "";
    var top = el("div", "gscreen__top");
    var back = el("button", "btn btn--sm", "‹ Leave");
    back.addEventListener("click", function () { stopOnline(); renderLobby(); });
    top.appendChild(back);
    top.appendChild(el("h2", "gscreen__name", mod.name + " · " + rcoin(match.stake_cents * 2) + " rcoin pot"));
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

    // subscribe to match row updates
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
      if (m.status === "open") { turnbar.textContent = waitMsg || "Waiting for a player to join…"; turnbar.className = "gturn opp"; mod.view(st, onlineApi(board, false)); return; }
      var res = mod.result(st);
      if (res && m.status !== "settled" && m.status !== "disputed" && !online.reported) return reportResult(res);
      if (m.status === "settled" || m.status === "disputed") return finishOnline(m, res);
      var yourTurn = (st.turn === online.seat);
      turnbar.textContent = yourTurn ? "Your turn." : "Opponent's turn…";
      turnbar.className = "gturn " + (yourTurn ? "you" : "opp");
      mod.view(st, onlineApi(board, yourTurn));
    };
    online.render();
  }

  function onlineApi(board, yourTurn) {
    var mod = online.mod;
    var api = { board: board, canMove: yourTurn, oppName: online.seat === 0 ? "Guest" : "Host", online: true };
    // per-game scratch (checkers selection, eights color pick) persists on `online`
    Object.defineProperty(api, "_ck", { get: function () { return online._ck; }, set: function (v) { online._ck = v; } });
    Object.defineProperty(api, "_ce", { get: function () { return online._ce; }, set: function (v) { online._ce = v; } });
    api.rerender = online.render;
    api.move = function (m) {
      if (online.state.turn !== online.seat) return;
      var next = mod.apply(online.state, m);
      online.state = next;
      // determine turn_id to send
      var nextSeat = next.turn;
      var nextTurnId = nextSeat === 0 ? online.match.host_id : online.match.guest_id;
      var res = mod.result(next);
      CTX.client.rpc("rib_game_move", { p_match_id: online.match.id, p_state: next, p_next_turn: res ? null : nextTurnId })
        .then(function (r) { if (r.error) { /* keep UI; will resync on next event */ } });
      online.render();
      if (res) reportResult(res);
    };
    return api;
  }

  function onlineUpdate(row) {
    if (!online || row.id !== online.match.id) return;
    online.match = row;
    if (row.state) online.state = row.state;
    online.render();
  }

  function reportResult(res) {
    if (!online || online.reported) return;
    online.reported = true;
    var winnerId = null;
    if (res.winner != null) winnerId = res.winner === 0 ? online.match.host_id : online.match.guest_id;
    CTX.client.rpc("rib_game_report", { p_match_id: online.match.id, p_winner_id: winnerId })
      .then(function (r) { if (!r.error && r.data) { online.match = r.data; if (CTX.refreshWallet) CTX.refreshWallet(); online.render(); } });
  }

  function finishOnline(m, res) {
    var board = h("g-board"), turnbar = h("g-turn"), over = h("g-over");
    board.innerHTML = ""; online.mod.view(online.state, onlineApi(board, false));
    turnbar.textContent = "";
    over.hidden = false;
    if (m.status === "disputed") {
      over.innerHTML = '<h3>Result in dispute</h3><p>The two reports didn\'t match, so the pot is held until it\'s resolved.</p>';
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

  return { init: init, CATALOG: CATALOG, MODULES: MODULES, register: register, finishCatalog: finishCatalog };
})();
