// Reversi — pure rules (no DOM). Shared by the web client (practice + UI)
// and the game-move Edge Function (server-authoritative staked play).
// Seat 0 = host, seat 1 = guest. state.turn = 0|1.
import { clone } from "./util.js";

const Reversi = {
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
};

export default Reversi;
