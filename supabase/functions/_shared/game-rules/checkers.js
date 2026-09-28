// Checkers — pure rules (no DOM). Shared by the web client (practice + UI)
// and the game-move Edge Function (server-authoritative staked play).
// Seat 0 = host, seat 1 = guest. state.turn = 0|1.
// board: 64 cells, null or {p:0|1, k:bool}. Player 0 moves up (row decreasing),
// player 1 moves down. Only dark squares used.
import { clone } from "./util.js";

const Checkers = {
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
};

export default Checkers;
