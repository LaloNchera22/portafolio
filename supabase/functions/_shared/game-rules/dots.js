// Dots — pure rules (no DOM). Shared by the web client (practice + UI)
// and the game-move Edge Function (server-authoritative staked play).
// Seat 0 = host, seat 1 = guest. state.turn = 0|1.
import { clone, pick } from "./util.js";

export const DB = 4; // boxes per side
const Dots = {
  id: "dots", name: "Dots & Boxes", tag: "8 min", icon: "▦",
  blurb: "Draw a line, close a box, go again. Most boxes wins.",
  // edges: horizontal (DB+1 rows x DB cols) + vertical (DB rows x DB+1 cols)
  init: function () {
    var H = (DB + 1) * DB, V = DB * (DB + 1);
    return { h: new Array(H).fill(0), v: new Array(V).fill(0), owner: new Array(DB * DB).fill(-1), turn: 0, score: [0, 0] };
  },
  legal: function (s) {
    var m = [];
    for (var i = 0; i < s.h.length; i++) if (!s.h[i]) m.push({ t: "h", i: i });
    for (var j = 0; j < s.v.length; j++) if (!s.v[j]) m.push({ t: "v", j: j });
    return m;
  },
  _boxSides: function (r, c) { return { top: { t: "h", i: r * DB + c }, bot: { t: "h", i: (r + 1) * DB + c }, left: { t: "v", j: r * (DB + 1) + c }, right: { t: "v", j: r * (DB + 1) + c + 1 } }; },
  apply: function (s, m) {
    var n = clone(s);
    if (m.t === "h") n.h[m.i] = 1; else n.v[m.j] = 1;
    var closedAny = false;
    for (var r = 0; r < DB; r++) for (var c = 0; c < DB; c++) {
      if (n.owner[r * DB + c] >= 0) continue;
      var sd = Dots._boxSides(r, c);
      if (n.h[sd.top.i] && n.h[sd.bot.i] && n.v[sd.left.j] && n.v[sd.right.j]) { n.owner[r * DB + c] = s.turn; n.score[s.turn]++; closedAny = true; }
    }
    if (!closedAny) n.turn = s.turn ^ 1; // closing a box grants another move
    return n;
  },
  result: function (s) {
    if (s.owner.every(function (o) { return o >= 0; })) return { over: true, winner: s.score[0] === s.score[1] ? null : (s.score[0] > s.score[1] ? 0 : 1) };
    return null;
  },
  _completes: function (s, m) { var n = Dots.apply(s, m); return n.score[s.turn] > s.score[s.turn]; },
  _thirdSide: function (s, m) {
    // does drawing m create a box with 3 sides (a gift)?
    var t = clone(s); if (m.t === "h") t.h[m.i] = 1; else t.v[m.j] = 1;
    for (var r = 0; r < DB; r++) for (var c = 0; c < DB; c++) { if (t.owner[r * DB + c] >= 0) continue; var sd = Dots._boxSides(r, c); var cnt = (t.h[sd.top.i] ? 1 : 0) + (t.h[sd.bot.i] ? 1 : 0) + (t.v[sd.left.j] ? 1 : 0) + (t.v[sd.right.j] ? 1 : 0); if (cnt === 3) return true; } return false;
  },
  bot: function (s) {
    var legal = Dots.legal(s);
    var wins = legal.filter(function (m) { return Dots._completes(s, m); });
    if (wins.length) return wins[0];
    var safe = legal.filter(function (m) { return !Dots._thirdSide(s, m); });
    return safe.length ? pick(safe) : pick(legal);
  },
};

export default Dots;
