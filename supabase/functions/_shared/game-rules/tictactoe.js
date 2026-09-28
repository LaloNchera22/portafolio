// TicTacToe — pure rules (no DOM). Shared by the web client (practice + UI)
// and the game-move Edge Function (server-authoritative staked play).
// Seat 0 = host, seat 1 = guest. state.turn = 0|1.

const TicTacToe = {
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
};

export default TicTacToe;
