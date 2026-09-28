// Connect4 — pure rules (no DOM). Shared by the web client (practice + UI)
// and the game-move Edge Function (server-authoritative staked play).
// Seat 0 = host, seat 1 = guest. state.turn = 0|1.
import { clone } from "./util.js";

export const COLS = 7, ROWS = 6;
const Connect4 = {
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
};

export default Connect4;
