// Mancala — pure rules (no DOM). Shared by the web client (practice + UI)
// and the game-move Edge Function (server-authoritative staked play).
// Seat 0 = host, seat 1 = guest. state.turn = 0|1.
// pits[0..5] you, pits[6] your store, pits[7..12] opp, pits[13] opp store.
import { clone } from "./util.js";

const Mancala = {
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
};

export default Mancala;
