/* ============================================================================
 * Runinback — Games, extra pack. 21 more playable games registered onto the
 * RIBGames engine (init/legal/apply/result/bot/view per game). Each plays two
 * ways like the core six: free practice vs the house bot, or staked for rcoin.
 * Loop-prone movement games carry a move-cap draw guard so a match always ends.
 * ========================================================================== */
(function () {
  "use strict";
  var R = window.RIBGames;
  if (!R || !R.register) return;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function pick(a) { return a[(Math.random() * a.length) | 0]; }

  /* generic bounded minimax for small perfect-info games */
  function minimax(mod, s, me, depth, maxDepth, alpha, beta) {
    var r = mod.result(s);
    if (r) { if (r.winner === me) return 100 - depth; if (r.winner == null) return 0; return depth - 100; }
    if (depth >= maxDepth) return 0;
    var moves = mod.legal(s), maxing = (s.turn === me), best = maxing ? -1e9 : 1e9;
    for (var i = 0; i < moves.length; i++) {
      var v = minimax(mod, mod.apply(s, moves[i]), me, depth + 1, maxDepth, alpha, beta);
      if (maxing) { if (v > best) best = v; if (best > alpha) alpha = best; } else { if (v < best) best = v; if (best < beta) beta = best; }
      if (beta <= alpha) break;
    }
    return best;
  }
  function bestBy(mod, s, maxDepth) {
    var me = s.turn, moves = mod.legal(s), best = moves[0], bv = -1e9;
    for (var i = 0; i < moves.length; i++) {
      var v = minimax(mod, mod.apply(s, moves[i]), me, 0, maxDepth, -1e9, 1e9);
      if (v > bv) { bv = v; best = moves[i]; }
    }
    return best;
  }

  /* ======================================================================= */
  /* 1. Gomoku — five in a row on a 12x12 board                              */
  /* ======================================================================= */
  var GN = 12;
  var Gomoku = {
    id: "gomoku", name: "Gomoku", tag: "5 min", icon: "⬦",
    blurb: "Five in a row on a big board — no gravity, place anywhere.",
    init: function () { return { b: new Array(GN * GN).fill(null), turn: 0, last: null }; },
    legal: function (s) { var m = []; for (var i = 0; i < GN * GN; i++) if (s.b[i] == null) m.push(i); return m; },
    apply: function (s, i) { var n = clone(s); n.b[i] = s.turn; n.last = i; n.turn = s.turn ^ 1; return n; },
    _line: function (b, i, dx, dy, p) { var x = i % GN, y = (i / GN) | 0, c = 0; for (var k = 1; k < 5; k++) { var nx = x + dx * k, ny = y + dy * k; if (nx < 0 || nx >= GN || ny < 0 || ny >= GN || b[ny * GN + nx] !== p) break; c++; } return c; },
    result: function (s) {
      if (s.last == null) return null;
      var p = s.b[s.last], D = [[1, 0], [0, 1], [1, 1], [1, -1]];
      for (var d = 0; d < 4; d++) { var run = 1 + Gomoku._line(s.b, s.last, D[d][0], D[d][1], p) + Gomoku._line(s.b, s.last, -D[d][0], -D[d][1], p); if (run >= 5) return { over: true, winner: p }; }
      return s.b.every(function (x) { return x != null; }) ? { over: true, winner: null } : null;
    },
    bot: function (s) {
      var me = s.turn, opp = me ^ 1, legal = Gomoku.legal(s), best = legal[0], bv = -1e9;
      // only consider cells near existing stones (speed + sense)
      var cand = legal.filter(function (i) { return Gomoku._near(s.b, i); }); if (!cand.length) cand = [GN * GN / 2 | 0];
      for (var k = 0; k < cand.length; k++) {
        var i = cand[k], sc = Gomoku._score(s.b, i, me) * 1.05 + Gomoku._score(s.b, i, opp);
        if (sc > bv) { bv = sc; best = i; }
      }
      return best;
    },
    _near: function (b, i) { var x = i % GN, y = (i / GN) | 0; for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) { var nx = x + dx, ny = y + dy; if (nx >= 0 && nx < GN && ny >= 0 && ny < GN && b[ny * GN + nx] != null) return true; } return false; },
    _score: function (b, i, p) { var D = [[1, 0], [0, 1], [1, 1], [1, -1]], best = 0; for (var d = 0; d < 4; d++) { var run = 1 + Gomoku._line(b, i, D[d][0], D[d][1], p) + Gomoku._line(b, i, -D[d][0], -D[d][1], p); best = Math.max(best, run); } return best >= 5 ? 100000 : Math.pow(10, best); },
    view: function (s, api) {
      var wrap = el("div", "ge-scroll");
      var g = el("div", "ge-grid ge-gomoku"); g.style.gridTemplateColumns = "repeat(" + GN + ", 1fr)";
      for (var i = 0; i < GN * GN; i++) (function (i) {
        var c = el("button", "ge-cell");
        if (s.b[i] != null) { var d = el("span", "ge-disc " + (s.b[i] === 0 ? "p0" : "p1")); c.appendChild(d); c.disabled = true; if (s.last === i) c.classList.add("just"); }
        else if (api.canMove) c.addEventListener("click", function () { api.move(i); }); else c.disabled = true;
        g.appendChild(c);
      })(i);
      wrap.appendChild(g); api.board.appendChild(wrap);
    }
  };

  /* ======================================================================= */
  /* 2. Dots & Boxes — 4x4 boxes                                             */
  /* ======================================================================= */
  var DB = 4; // boxes per side
  var Dots = {
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
    view: function (s, api) {
      var wrap = el("div", "ge-dots");
      for (var r = 0; r < DB + 1; r++) {
        var rowH = el("div", "ge-dots__rh");
        for (var c = 0; c < DB; c++) {
          rowH.appendChild(el("span", "ge-dots__dot"));
          (function (i) { var line = el("button", "ge-dots__h" + (s.h[i] ? " on" : "")); if (!s.h[i] && api.canMove) line.addEventListener("click", function () { api.move({ t: "h", i: i }); }); else line.disabled = true; rowH.appendChild(line); })(r * DB + c);
        }
        rowH.appendChild(el("span", "ge-dots__dot"));
        wrap.appendChild(rowH);
        if (r < DB) {
          var rowV = el("div", "ge-dots__rv");
          for (var c2 = 0; c2 < DB + 1; c2++) {
            (function (j) { var line = el("button", "ge-dots__v" + (s.v[j] ? " on" : "")); if (!s.v[j] && api.canMove) line.addEventListener("click", function () { api.move({ t: "v", j: j }); }); else line.disabled = true; rowV.appendChild(line); })(r * (DB + 1) + c2);
            if (c2 < DB) { var bi = r * DB + c2, o = s.owner[bi]; var box = el("span", "ge-dots__box" + (o >= 0 ? (o === 0 ? " p0" : " p1") : "")); rowV.appendChild(box); }
          }
          wrap.appendChild(rowV);
        }
      }
      api.board.appendChild(wrap);
      var sc = el("div", "ge-score"); sc.innerHTML = '<span class="p0">You ' + s.score[0] + '</span><span class="p1">' + api.oppName + ' ' + s.score[1] + '</span>';
      api.board.appendChild(sc);
    }
  };

  /* ======================================================================= */
  /* 3. Nine Men's Morris                                                    */
  /* ======================================================================= */
  var MILL_ADJ = [[1,9],[0,2,4],[1,14],[4,10],[1,3,5,7],[4,13],[7,11],[4,6,8],[7,12],[0,10,21],[3,9,11,18],[6,10,15],[8,13,17],[5,12,14,20],[2,13,23],[11,16],[15,17,19],[12,16],[10,19],[16,18,20,22],[13,19],[9,22],[19,21,23],[14,22]];
  var MILLS = [[0,1,2],[3,4,5],[6,7,8],[9,10,11],[12,13,14],[15,16,17],[18,19,20],[21,22,23],[0,9,21],[3,10,18],[6,11,15],[1,4,7],[16,19,22],[8,12,17],[5,13,20],[2,14,23]];
  var Morris = {
    id: "morris", name: "Nine Men's Morris", tag: "12 min", icon: "⊕",
    blurb: "Place nine, form mills of three, take your rival's pieces.",
    init: function () { return { b: new Array(24).fill(null), turn: 0, hand: [9, 9], remove: false, ply: 0 }; },
    _mills: function (b, i, p) { for (var k = 0; k < MILLS.length; k++) { var m = MILLS[k]; if (m.indexOf(i) >= 0 && b[m[0]] === p && b[m[1]] === p && b[m[2]] === p) return true; } return false; },
    _count: function (b, p) { var c = 0; for (var i = 0; i < 24; i++) if (b[i] === p) c++; return c; },
    _removable: function (s, opp) {
      var all = [], nonMill = [];
      for (var i = 0; i < 24; i++) if (s.b[i] === opp) { all.push(i); if (!Morris._mills(s.b, i, opp)) nonMill.push(i); }
      return nonMill.length ? nonMill : all;
    },
    legal: function (s) {
      var me = s.turn, opp = me ^ 1, out = [];
      if (s.remove) { Morris._removable(s, opp).forEach(function (i) { out.push({ t: "rm", i: i }); }); return out; }
      if (s.hand[me] > 0) { for (var i = 0; i < 24; i++) if (s.b[i] == null) out.push({ t: "place", to: i }); return out; }
      var cnt = Morris._count(s.b, me), fly = cnt === 3;
      for (var f = 0; f < 24; f++) if (s.b[f] === me) {
        var dests = fly ? (function () { var d = []; for (var x = 0; x < 24; x++) if (s.b[x] == null) d.push(x); return d; })() : MILL_ADJ[f].filter(function (x) { return s.b[x] == null; });
        dests.forEach(function (to) { out.push({ t: "move", from: f, to: to }); });
      }
      return out;
    },
    apply: function (s, m) {
      var n = clone(s), me = s.turn; n.ply++;
      if (m.t === "rm") { n.b[m.i] = null; n.remove = false; n.turn = me ^ 1; return n; }
      if (m.t === "place") { n.b[m.to] = me; n.hand[me]--; if (Morris._mills(n.b, m.to, me)) { n.remove = true; } else n.turn = me ^ 1; return n; }
      // move
      n.b[m.from] = null; n.b[m.to] = me; if (Morris._mills(n.b, m.to, me)) { n.remove = true; } else n.turn = me ^ 1; return n;
    },
    result: function (s) {
      if (s.ply >= 300) return { over: true, winner: null };
      var me = s.turn;
      // a player with <3 pieces after placing everything loses; or no legal move loses
      for (var p = 0; p < 2; p++) { if (s.hand[p] === 0 && Morris._count(s.b, p) < 3) return { over: true, winner: p ^ 1 }; }
      if (!Morris.legal(s).length) return { over: true, winner: me ^ 1 };
      return null;
    },
    bot: function (s) {
      var legal = Morris.legal(s), me = s.turn, opp = me ^ 1;
      if (s.remove) { // remove the most valuable (prefer one that breaks an opp near-mill)
        return legal[0];
      }
      // prefer a move that forms a mill
      for (var i = 0; i < legal.length; i++) { var n = Morris.apply(s, legal[i]); if (n.remove && n.turn === me) return legal[i]; }
      // block: a placement/move that occupies a square completing opp mill next
      var block = legal.filter(function (m) { var to = m.to; if (to == null) return false; var t = clone(s); if (m.from != null) t.b[m.from] = null; t.b[to] = opp; return Morris._mills(t.b, to, opp); });
      if (block.length) return block[0];
      return pick(legal);
    },
    view: function (s, api) {
      var pos = [[0,0],[3,0],[6,0],[1,1],[3,1],[5,1],[2,2],[3,2],[4,2],[0,3],[1,3],[2,3],[4,3],[5,3],[6,3],[2,4],[3,4],[4,4],[1,5],[3,5],[5,5],[0,6],[3,6],[6,6]];
      var wrap = el("div", "ge-morris");
      var sel = api._ck && api._ck.from;
      var legal = api.canMove ? Morris.legal(s) : [];
      for (var i = 0; i < 24; i++) (function (i) {
        var b = el("button", "ge-morris__p"); b.style.gridColumn = (pos[i][0] + 1); b.style.gridRow = (pos[i][1] + 1);
        if (s.b[i] != null) b.appendChild(el("span", "ge-disc " + (s.b[i] === 0 ? "p0" : "p1")));
        b.disabled = true;
        if (api.canMove) {
          if (s.remove) { if (legal.some(function (m) { return m.t === "rm" && m.i === i; })) { b.disabled = false; b.classList.add("rm"); b.addEventListener("click", function () { api.move({ t: "rm", i: i }); }); } }
          else if (s.hand[s.turn] > 0) { if (s.b[i] == null && legal.some(function (m) { return m.to === i; })) { b.disabled = false; b.classList.add("ok"); b.addEventListener("click", function () { api.move({ t: "place", to: i }); }); } }
          else { // moving phase
            if (sel != null) { if (legal.some(function (m) { return m.from === sel && m.to === i; })) { b.disabled = false; b.classList.add("ok"); b.addEventListener("click", function () { var f = sel; api._ck = null; api.move({ t: "move", from: f, to: i }); }); } else if (i === sel) { b.disabled = false; b.classList.add("sel"); b.addEventListener("click", function () { api._ck = null; api.rerender(); }); } }
            else if (legal.some(function (m) { return m.from === i; })) { b.disabled = false; b.classList.add("movable"); b.addEventListener("click", function () { api._ck = { from: i }; api.rerender(); }); }
          }
        }
        wrap.appendChild(b);
      })(i);
      api.board.appendChild(wrap);
      var info = el("p", "ge-info"); info.textContent = s.remove ? "Mill! Remove one of your rival's pieces." : (s.hand[s.turn] > 0 ? ("In hand — you: " + s.hand[0] + ", " + api.oppName + ": " + s.hand[1]) : "Move a piece along a line.");
      api.board.appendChild(info);
    }
  };

  /* ======================================================================= */
  /* 4. Nim (misère, three heaps)                                            */
  /* ======================================================================= */
  var Nim = {
    id: "nim", name: "Nim", tag: "2 min", icon: "≡",
    blurb: "Take any number from one row. Take the last object and you lose.",
    init: function () { return { heaps: [3, 5, 7], turn: 0 }; },
    legal: function (s) { var m = []; for (var h = 0; h < s.heaps.length; h++) for (var k = 1; k <= s.heaps[h]; k++) m.push({ h: h, k: k }); return m; },
    apply: function (s, m) { var n = clone(s); n.heaps[m.h] -= m.k; n.turn = s.turn ^ 1; return n; },
    result: function (s) { return s.heaps.every(function (x) { return x === 0; }) ? { over: true, winner: s.turn } : null; }, // last to take loses => mover (who now can't) wins
    bot: function (s) {
      var nonEmpty = s.heaps.filter(function (x) { return x > 0; });
      var x = 0; s.heaps.forEach(function (h) { x ^= h; });
      var ones = nonEmpty.filter(function (h) { return h > 1; }).length;
      // misère strategy
      if (ones === 0) { // all heaps are 1: leave an odd count of 1s? leave even so opponent takes last
        var count1 = nonEmpty.length; var h1 = s.heaps.indexOf(1); return { h: h1, k: 1 }; // take one (parity handled by forced line)
      }
      if (x !== 0) { for (var h = 0; h < s.heaps.length; h++) { var target = s.heaps[h] ^ x; if (target < s.heaps[h]) return { h: h, k: s.heaps[h] - target }; } }
      return pick(Nim.legal(s));
    },
    view: function (s, api) {
      var wrap = el("div", "ge-nim");
      for (var h = 0; h < s.heaps.length; h++) (function (h) {
        var row = el("div", "ge-nim__row");
        for (var k = 0; k < s.heaps[h]; k++) { (function (take) { var o = el("button", "ge-nim__o"); if (api.canMove) o.addEventListener("click", function () { api.move({ h: h, k: s.heaps[h] - take }); }); else o.disabled = true; row.appendChild(o); })(k); }
        wrap.appendChild(row);
      })(h);
      api.board.appendChild(wrap);
      api.board.appendChild(el("p", "ge-info", "Click an object to take it and everything to its right in that row."));
    }
  };

  /* ======================================================================= */
  /* 5. Chomp — 5x4 grid, top-left is poison                                 */
  /* ======================================================================= */
  var CW = 5, CH = 4;
  var Chomp = {
    id: "chomp", name: "Chomp", tag: "3 min", icon: "▧",
    blurb: "Eat a square and everything below-right. The poison corner loses.",
    init: function () { var b = []; for (var i = 0; i < CW * CH; i++) b.push(1); return { b: b, turn: 0 }; },
    legal: function (s) { var m = []; for (var i = 0; i < CW * CH; i++) if (s.b[i]) m.push(i); return m; },
    apply: function (s, i) { var n = clone(s), x0 = i % CW, y0 = (i / CW) | 0; for (var y = y0; y < CH; y++) for (var x = x0; x < CW; x++) n.b[y * CW + x] = 0; n.turn = s.turn ^ 1; return n; },
    result: function (s) { return s.b[0] === 0 ? { over: true, winner: s.turn } : null; }, // whoever ate poison (previous) loses => mover wins
    bot: function (s) {
      var legal = Chomp.legal(s);
      // avoid eating the poison unless forced
      var safe = legal.filter(function (i) { return i !== 0; });
      var pool = safe.length ? safe : legal;
      // try to leave opponent a losing shape: prefer moves that leave an L / symmetric-ish; heuristic: smallest bite
      pool.sort(function (a, b) { var ca = Chomp._remaining(Chomp.apply(s, a)), cb = Chomp._remaining(Chomp.apply(s, b)); return cb - ca; });
      return pool[0];
    },
    _remaining: function (s) { var c = 0; for (var i = 0; i < s.b.length; i++) c += s.b[i]; return c; },
    view: function (s, api) {
      var g = el("div", "ge-grid"); g.style.gridTemplateColumns = "repeat(" + CW + ", 1fr)"; g.style.maxWidth = (CW * 56) + "px";
      for (var i = 0; i < CW * CH; i++) (function (i) {
        var c = el("button", "ge-cell ge-chomp" + (s.b[i] ? "" : " gone") + (i === 0 ? " poison" : ""));
        if (i === 0 && s.b[i]) c.textContent = "☠";
        if (s.b[i] && api.canMove) c.addEventListener("click", function () { api.move(i); }); else c.disabled = true;
        g.appendChild(c);
      })(i);
      api.board.appendChild(g);
      api.board.appendChild(el("p", "ge-info", "Eat a square (and all below and right of it). Don't be forced to eat the ☠."));
    }
  };

  /* ======================================================================= */
  /* 6. Order and Chaos — 6x6                                                */
  /* ======================================================================= */
  var OC = 6;
  var OrderChaos = {
    id: "orderchaos", name: "Order & Chaos", tag: "6 min", icon: "◨",
    blurb: "You're Order: make five X or O in a row. The bot (Chaos) stops you.",
    // seat 0 = Order (wins on 5-in-row of same symbol). seat 1 = Chaos (wins if board fills with no 5).
    init: function () { return { b: new Array(OC * OC).fill(null), turn: 0 }; },
    legal: function (s) { var m = []; for (var i = 0; i < OC * OC; i++) if (s.b[i] == null) { m.push({ i: i, v: "X" }); m.push({ i: i, v: "O" }); } return m; },
    apply: function (s, m) { var n = clone(s); n.b[m.i] = m.v; n.last = m.i; n.turn = s.turn ^ 1; return n; },
    _five: function (b) {
      var D = [[1, 0], [0, 1], [1, 1], [1, -1]];
      for (var y = 0; y < OC; y++) for (var x = 0; x < OC; x++) { var v = b[y * OC + x]; if (!v) continue; for (var d = 0; d < 4; d++) { var run = 1; for (var k = 1; k < 5; k++) { var nx = x + D[d][0] * k, ny = y + D[d][1] * k; if (nx < 0 || nx >= OC || ny < 0 || ny >= OC || b[ny * OC + nx] !== v) break; run++; } if (run >= 5) return true; } }
      return false;
    },
    result: function (s) {
      if (OrderChaos._five(s.b)) return { over: true, winner: 0 };            // Order made five
      if (s.b.every(function (x) { return x != null; })) return { over: true, winner: 1 }; // full, Chaos wins
      return null;
    },
    bot: function (s) { // Chaos: block any immediate five, else play to avoid creating fives
      var legal = OrderChaos.legal(s);
      var safe = legal.filter(function (m) { return !OrderChaos._five(OrderChaos.apply(s, m).b); });
      return safe.length ? pick(safe) : pick(legal);
    },
    view: function (s, api) {
      var choose = api._oc && api._oc.i;
      var g = el("div", "ge-grid"); g.style.gridTemplateColumns = "repeat(" + OC + ", 1fr)"; g.style.maxWidth = (OC * 56) + "px";
      for (var i = 0; i < OC * OC; i++) (function (i) {
        var c = el("button", "ge-cell");
        if (s.b[i] != null) { c.textContent = s.b[i]; c.classList.add(s.b[i] === "X" ? "p0" : "p1"); c.disabled = true; if (s.last === i) c.classList.add("just"); }
        else if (api.canMove) { if (choose === i) c.classList.add("sel"); c.addEventListener("click", function () { api._oc = { i: i }; api.rerender(); }); }
        else c.disabled = true;
        g.appendChild(c);
      })(i);
      api.board.appendChild(g);
      if (choose != null) {
        var pickRow = el("div", "ge-pick");
        pickRow.appendChild(el("span", "ge-info", "Place:"));
        ["X", "O"].forEach(function (v) { var b = el("button", "btn btn--sm", v); b.addEventListener("click", function () { var i = api._oc.i; api._oc = null; api.move({ i: i, v: v }); }); pickRow.appendChild(b); });
        api.board.appendChild(pickRow);
      } else api.board.appendChild(el("p", "ge-info", "You are Order: make five of the same symbol in a row (X or O)."));
    }
  };

  /* ======================================================================= */
  /* 7. Misère Tic-Tac-Toe (make three and you LOSE)                        */
  /* ======================================================================= */
  var Misere = {
    id: "misere", name: "Toe-Tac-Tic", tag: "2 min", icon: "⊗",
    blurb: "Reverse tic-tac-toe: make three in a row and you lose.",
    init: function () { return { b: new Array(9).fill(null), turn: 0 }; },
    legal: function (s) { var m = []; for (var i = 0; i < 9; i++) if (s.b[i] == null) m.push(i); return m; },
    apply: function (s, i) { var nb = s.b.slice(); nb[i] = s.turn; return { b: nb, turn: s.turn ^ 1 }; },
    _three: function (b, p) { var L = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]; return L.some(function (a) { return b[a[0]] === p && b[a[1]] === p && b[a[2]] === p; }); },
    result: function (s) {
      if (Misere._three(s.b, 0)) return { over: true, winner: 1 };
      if (Misere._three(s.b, 1)) return { over: true, winner: 0 };
      return s.b.every(function (x) { return x != null; }) ? { over: true, winner: null } : null;
    },
    bot: function (s) { return bestBy(Misere, s, 9); },
    view: TicTacToeView("ge-ttt3")
  };
  function TicTacToeView(cls) {
    return function (s, api) {
      var g = el("div", "ge-ttt3");
      for (var i = 0; i < 9; i++) (function (i) {
        var c = el("button", "ge-cell ge-big");
        if (s.b[i] != null) { c.textContent = s.b[i] === 0 ? "✕" : "◯"; c.classList.add(s.b[i] === 0 ? "p0" : "p1"); c.disabled = true; }
        else if (api.canMove) c.addEventListener("click", function () { api.move(i); }); else c.disabled = true;
        g.appendChild(c);
      })(i);
      api.board.appendChild(g);
    };
  }

  /* ======================================================================= */
  /* 8. Ultimate Tic-Tac-Toe                                                 */
  /* ======================================================================= */
  var UTTT = {
    id: "uttt", name: "Ultimate Tic-Tac-Toe", tag: "10 min", icon: "▣",
    blurb: "Nine boards in one. Win small boards to claim the big one.",
    init: function () { return { sb: Array.from({ length: 9 }, function () { return new Array(9).fill(null); }), won: new Array(9).fill(null), turn: 0, active: -1 }; },
    _winLines: function (cells, p) { var L = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]; return L.some(function (a) { return cells[a[0]] === p && cells[a[1]] === p && cells[a[2]] === p; }); },
    _boardOpen: function (s, b) { return s.won[b] == null && s.sb[b].some(function (c) { return c == null; }); },
    legal: function (s) {
      var m = [], boards = (s.active >= 0 && UTTT._boardOpen(s, s.active)) ? [s.active] : [];
      if (!boards.length) for (var b = 0; b < 9; b++) if (UTTT._boardOpen(s, b)) boards.push(b);
      boards.forEach(function (b) { for (var c = 0; c < 9; c++) if (s.sb[b][c] == null) m.push({ b: b, c: c }); });
      return m;
    },
    apply: function (s, m) {
      var n = clone(s); n.sb[m.b][m.c] = s.turn;
      if (UTTT._winLines(n.sb[m.b], s.turn)) n.won[m.b] = s.turn;
      else if (n.sb[m.b].every(function (x) { return x != null; })) n.won[m.b] = -1; // drawn board
      n.active = m.c; n.last = { b: m.b, c: m.c }; n.turn = s.turn ^ 1;
      return n;
    },
    result: function (s) {
      var big = s.won.map(function (w) { return w === 0 || w === 1 ? w : null; });
      if (UTTT._winLines(big, 0)) return { over: true, winner: 0 };
      if (UTTT._winLines(big, 1)) return { over: true, winner: 1 };
      if (s.won.every(function (w) { return w != null; })) { var c0 = s.won.filter(function (w) { return w === 0; }).length, c1 = s.won.filter(function (w) { return w === 1; }).length; return { over: true, winner: c0 === c1 ? null : (c0 > c1 ? 0 : 1) }; }
      return null;
    },
    bot: function (s) {
      var legal = UTTT.legal(s), me = s.turn, opp = me ^ 1, best = legal[0], bv = -1e9;
      for (var i = 0; i < legal.length; i++) {
        var m = legal[i], n = UTTT.apply(s, m), sc = 0;
        if (n.won[m.b] === me) sc += 5;
        if (UTTT._winLines(n.sb[m.b], me)) sc += 5;
        // avoid sending opponent to an open board where they can win a board
        if (m.c === 4) sc += 1;
        sc += Math.random();
        if (sc > bv) { bv = sc; best = m; }
      }
      return best;
    },
    view: function (s, api) {
      var legalSet = {}; if (api.canMove) UTTT.legal(s).forEach(function (m) { legalSet[m.b + ":" + m.c] = 1; });
      var big = el("div", "ge-uttt");
      for (var b = 0; b < 9; b++) (function (b) {
        var board = el("div", "ge-uttt__sb" + (s.won[b] != null ? " done" : "") + ((s.active === b || (s.active < 0 || !UTTT._boardOpen(s, s.active))) && api.canMove && s.won[b] == null ? " active" : ""));
        if (s.won[b] === 0 || s.won[b] === 1) { board.classList.add(s.won[b] === 0 ? "w0" : "w1"); board.appendChild(el("span", "ge-uttt__big", s.won[b] === 0 ? "✕" : "◯")); }
        else { for (var c = 0; c < 9; c++) (function (c) { var cell = el("button", "ge-uttt__c"); if (s.sb[b][c] != null) { cell.textContent = s.sb[b][c] === 0 ? "✕" : "◯"; cell.classList.add(s.sb[b][c] === 0 ? "p0" : "p1"); cell.disabled = true; } else if (legalSet[b + ":" + c]) cell.addEventListener("click", function () { api.move({ b: b, c: c }); }); else cell.disabled = true; board.appendChild(cell); })(c); }
        big.appendChild(board);
      })(b);
      api.board.appendChild(big);
    }
  };

  /* ======================================================================= */
  /* 9. Hexapawn (3x3)                                                       */
  /* ======================================================================= */
  var Hexapawn = {
    id: "hexapawn", name: "Hexapawn", tag: "2 min", icon: "⇅",
    blurb: "Tiny pawn duel. Reach the far side or leave your rival stuck.",
    init: function () { return { b: [1, 1, 1, null, null, null, 0, 0, 0], turn: 0 }; }, // 0 moves up, 1 moves down
    legal: function (s) {
      var m = [], dir = s.turn === 0 ? -3 : 3, opp = s.turn ^ 1;
      for (var i = 0; i < 9; i++) if (s.b[i] === s.turn) {
        var f = i + dir; if (f >= 0 && f < 9 && s.b[f] == null) m.push({ from: i, to: f });
        var col = i % 3;
        [dir - 1, dir + 1].forEach(function (d) { var t = i + d; if (t < 0 || t >= 9) return; var tc = t % 3; if (Math.abs(tc - col) !== 1) return; if (s.b[t] === opp) m.push({ from: i, to: t }); });
      }
      return m;
    },
    apply: function (s, m) { var n = clone(s); n.b[m.to] = s.turn; n.b[m.from] = null; n.turn = s.turn ^ 1; return n; },
    result: function (s) {
      for (var i = 0; i < 3; i++) if (s.b[i] === 0) return { over: true, winner: 0 };
      for (var j = 6; j < 9; j++) if (s.b[j] === 1) return { over: true, winner: 1 };
      if (!Hexapawn.legal(s).length) return { over: true, winner: s.turn ^ 1 };
      return null;
    },
    bot: function (s) { return bestBy(Hexapawn, s, 12); },
    view: function (s, api) {
      var sel = api._ck && api._ck.from, legal = api.canMove ? Hexapawn.legal(s) : [];
      var g = el("div", "ge-grid"); g.style.gridTemplateColumns = "repeat(3, 1fr)"; g.style.maxWidth = "220px";
      for (var i = 0; i < 9; i++) (function (i) {
        var c = el("button", "ge-cell ge-big"); c.disabled = true;
        if (s.b[i] != null) c.appendChild(el("span", "ge-disc " + (s.b[i] === 0 ? "p0" : "p1")));
        if (api.canMove) {
          if (sel != null) { if (legal.some(function (m) { return m.from === sel && m.to === i; })) { c.disabled = false; c.classList.add("target"); c.addEventListener("click", function () { var f = sel; api._ck = null; api.move({ from: f, to: i }); }); } else if (i === sel) { c.disabled = false; c.classList.add("sel"); c.addEventListener("click", function () { api._ck = null; api.rerender(); }); } }
          else if (legal.some(function (m) { return m.from === i; })) { c.disabled = false; c.classList.add("movable"); c.addEventListener("click", function () { api._ck = { from: i }; api.rerender(); }); }
        }
        g.appendChild(c);
      })(i);
      api.board.appendChild(g);
    }
  };

  /* ======================================================================= */
  /* 10. Breakthrough (6x6)                                                  */
  /* ======================================================================= */
  var BT = 6;
  var Breakthrough = {
    id: "breakthrough", name: "Breakthrough", tag: "8 min", icon: "⇧",
    blurb: "March a pawn to the far rank. Capture only on the diagonal.",
    init: function () { var b = new Array(BT * BT).fill(null); for (var c = 0; c < BT; c++) { b[c] = 1; b[BT + c] = 1; b[(BT - 2) * BT + c] = 0; b[(BT - 1) * BT + c] = 0; } return { b: b, turn: 0 }; },
    legal: function (s) {
      var m = [], dir = s.turn === 0 ? -1 : 1, opp = s.turn ^ 1;
      for (var i = 0; i < BT * BT; i++) if (s.b[i] === s.turn) {
        var r = (i / BT) | 0, c = i % BT, nr = r + dir;
        if (nr < 0 || nr >= BT) continue;
        if (s.b[nr * BT + c] == null) m.push({ from: i, to: nr * BT + c });      // straight only into empty
        [c - 1, c + 1].forEach(function (nc) { if (nc < 0 || nc >= BT) return; var t = nr * BT + nc; if (s.b[t] == null || s.b[t] === opp) m.push({ from: i, to: t }); }); // diagonal move or capture
      }
      return m;
    },
    apply: function (s, m) { var n = clone(s); n.b[m.to] = s.turn; n.b[m.from] = null; n.turn = s.turn ^ 1; return n; },
    result: function (s) {
      for (var c = 0; c < BT; c++) { if (s.b[c] === 0) return { over: true, winner: 0 }; if (s.b[(BT - 1) * BT + c] === 1) return { over: true, winner: 1 }; }
      var has = [false, false]; for (var i = 0; i < BT * BT; i++) if (s.b[i] != null) has[s.b[i]] = true;
      if (!has[0]) return { over: true, winner: 1 }; if (!has[1]) return { over: true, winner: 0 };
      if (!Breakthrough.legal(s).length) return { over: true, winner: s.turn ^ 1 };
      return null;
    },
    bot: function (s) {
      var legal = Breakthrough.legal(s), me = s.turn, opp = me ^ 1, best = legal[0], bv = -1e9;
      for (var i = 0; i < legal.length; i++) {
        var m = legal[i], n = Breakthrough.apply(s, m), sc = 0, r = (m.to / BT) | 0;
        var rr = me === 0 ? (BT - 1 - r) : r; sc += rr * 2;                         // advance
        if (s.b[m.to] === opp) sc += 3;                                             // capture
        var rres = Breakthrough.result(n); if (rres && rres.winner === me) sc += 1000;
        // avoid moving into immediate loss
        var reply = Breakthrough.result(n); if (reply && reply.winner === opp) sc -= 1000;
        sc += Math.random();
        if (sc > bv) { bv = sc; best = m; }
      }
      return best;
    },
    view: gridMoveView(BT, "ge-bt", function (v) { return v === 0 ? "p0" : "p1"; })
  };

  // shared select-then-move grid view for pieces on an N*N board (b holds 0/1/null)
  function gridMoveView(N, cls, discClass) {
    return function (s, api) {
      var sel = api._ck && api._ck.from, mod = api._mod;
      var legal = api.canMove ? mod.legal(s) : [];
      var byTo = {}; if (sel != null) legal.forEach(function (m) { if (m.from === sel) byTo[m.to] = m; });
      var g = el("div", "ge-grid " + cls); g.style.gridTemplateColumns = "repeat(" + N + ", 1fr)"; g.style.maxWidth = (N * 52) + "px";
      for (var i = 0; i < N * N; i++) (function (i) {
        var r = (i / N) | 0, c = i % N, dark = (r + c) % 2 === 1;
        var cell = el("button", "ge-cell " + (dark ? "d" : "l")); cell.disabled = true;
        if (s.b[i] != null) cell.appendChild(el("span", "ge-disc " + discClass(s.b[i])));
        if (api.canMove) {
          if (sel != null) { if (byTo[i]) { cell.disabled = false; cell.classList.add("target"); cell.addEventListener("click", function () { var mv = byTo[i]; api._ck = null; api.move(mv); }); } else if (i === sel) { cell.disabled = false; cell.classList.add("sel"); cell.addEventListener("click", function () { api._ck = null; api.rerender(); }); } }
          else if (legal.some(function (m) { return m.from === i; })) { cell.disabled = false; cell.classList.add("movable"); cell.addEventListener("click", function () { api._ck = { from: i }; api.rerender(); }); }
        }
        g.appendChild(cell);
      })(i);
      api.board.appendChild(g);
    };
  }

  /* ======================================================================= */
  /* 11. Domineering (8x8)                                                   */
  /* ======================================================================= */
  var DM = 8;
  var Domineering = {
    id: "domineering", name: "Domineering", tag: "6 min", icon: "▭",
    blurb: "You place vertical tiles, the bot horizontal. No move left = loss.",
    init: function () { return { b: new Array(DM * DM).fill(0), turn: 0 }; }, // 0 = vertical (you), 1 = horizontal
    legal: function (s) {
      var m = [];
      if (s.turn === 0) { for (var r = 0; r < DM - 1; r++) for (var c = 0; c < DM; c++) { var i = r * DM + c; if (!s.b[i] && !s.b[i + DM]) m.push(i); } }
      else { for (var r2 = 0; r2 < DM; r2++) for (var c2 = 0; c2 < DM - 1; c2++) { var j = r2 * DM + c2; if (!s.b[j] && !s.b[j + 1]) m.push(j); } }
      return m;
    },
    apply: function (s, i) { var n = clone(s); if (s.turn === 0) { n.b[i] = 1; n.b[i + DM] = 1; } else { n.b[i] = 1; n.b[i + 1] = 1; } n.turn = s.turn ^ 1; return n; },
    result: function (s) { return Domineering.legal(s).length ? null : { over: true, winner: s.turn ^ 1 }; },
    bot: function (s) {
      var legal = Domineering.legal(s), best = legal[0], bv = -1e9;
      for (var i = 0; i < legal.length; i++) { var n = Domineering.apply(s, legal[i]); var mine = Domineering.legal({ b: n.b, turn: 1 }).length; var yours = Domineering.legal({ b: n.b, turn: 0 }).length; var sc = mine - yours + Math.random(); if (sc > bv) { bv = sc; best = legal[i]; } }
      return best;
    },
    view: function (s, api) {
      var legalSet = {}; if (api.canMove) Domineering.legal(s).forEach(function (i) { legalSet[i] = 1; });
      var g = el("div", "ge-grid"); g.style.gridTemplateColumns = "repeat(" + DM + ", 1fr)"; g.style.maxWidth = (DM * 40) + "px";
      for (var i = 0; i < DM * DM; i++) (function (i) {
        var c = el("button", "ge-cell ge-dm" + (s.b[i] ? " on" : "")); c.disabled = true;
        if (legalSet[i]) { c.disabled = false; c.classList.add("ok"); c.addEventListener("click", function () { api.move(i); }); }
        g.appendChild(c);
      })(i);
      api.board.appendChild(g);
      api.board.appendChild(el("p", "ge-info", "You place vertical tiles (a cell + the one below). Highlighted cells are where a tile fits."));
    }
  };

  /* ======================================================================= */
  /* 12. Pong Hau K'i — 5 nodes, 2 pieces each                               */
  /* ======================================================================= */
  var PH_ADJ = [[1, 2], [0, 2, 3], [0, 1, 4], [1, 4], [2, 3]];
  var PongHau = {
    id: "ponghau", name: "Pong Hau K'i", tag: "3 min", icon: "⧗",
    blurb: "A tiny trap game: pin your rival so they can't move.",
    init: function () { return { b: [0, 1, null, 1, 0], turn: 0, ply: 0 }; },
    legal: function (s) { var m = []; for (var i = 0; i < 5; i++) if (s.b[i] === s.turn) PH_ADJ[i].forEach(function (t) { if (s.b[t] == null) m.push({ from: i, to: t }); }); return m; },
    apply: function (s, m) { var n = clone(s); n.b[m.to] = s.turn; n.b[m.from] = null; n.turn = s.turn ^ 1; n.ply++; return n; },
    result: function (s) { if (s.ply >= 80) return { over: true, winner: null }; return Merge_noMoves(PongHau, s); },
    bot: function (s) { return bestBy(PongHau, s, 12); },
    view: function (s, api) {
      var pos = [[0, 0], [0, 2], [1, 1], [2, 0], [2, 2]];
      var sel = api._ck && api._ck.from, legal = api.canMove ? PongHau.legal(s) : [];
      var wrap = el("div", "ge-ph");
      for (var i = 0; i < 5; i++) (function (i) {
        var b = el("button", "ge-ph__n"); b.style.gridColumn = pos[i][1] + 1; b.style.gridRow = pos[i][0] + 1; b.disabled = true;
        if (s.b[i] != null) b.appendChild(el("span", "ge-disc " + (s.b[i] === 0 ? "p0" : "p1")));
        if (api.canMove) {
          if (sel != null) { if (legal.some(function (m) { return m.from === sel && m.to === i; })) { b.disabled = false; b.classList.add("ok"); b.addEventListener("click", function () { var f = sel; api._ck = null; api.move({ from: f, to: i }); }); } else if (i === sel) { b.disabled = false; b.classList.add("sel"); b.addEventListener("click", function () { api._ck = null; api.rerender(); }); } }
          else if (legal.some(function (m) { return m.from === i; })) { b.disabled = false; b.classList.add("movable"); b.addEventListener("click", function () { api._ck = { from: i }; api.rerender(); }); }
        }
        wrap.appendChild(b);
      })(i);
      api.board.appendChild(wrap);
    }
  };
  function Merge_noMoves(mod, s) { return mod.legal(s).length ? null : { over: true, winner: s.turn ^ 1 }; }

  /* ======================================================================= */
  /* 13. Achi (Three Men's Morris)                                           */
  /* ======================================================================= */
  var ACHI_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  var ACHI_ADJ = [[1,3,4],[0,2,4],[1,4,5],[0,4,6],[0,1,2,3,5,6,7,8],[2,4,8],[3,4,7],[4,6,8],[4,5,7]];
  var Achi = {
    id: "achi", name: "Achi", tag: "4 min", icon: "⊞",
    blurb: "Place three, then slide them to make a line of three.",
    init: function () { return { b: new Array(9).fill(null), turn: 0, hand: [3, 3], ply: 0 }; },
    legal: function (s) {
      var m = [];
      if (s.hand[s.turn] > 0) { for (var i = 0; i < 9; i++) if (s.b[i] == null) m.push({ t: "place", to: i }); return m; }
      for (var f = 0; f < 9; f++) if (s.b[f] === s.turn) ACHI_ADJ[f].forEach(function (t) { if (s.b[t] == null) m.push({ t: "move", from: f, to: t }); });
      return m;
    },
    apply: function (s, m) { var n = clone(s); n.ply++; if (m.t === "place") { n.b[m.to] = s.turn; n.hand[s.turn]--; } else { n.b[m.from] = null; n.b[m.to] = s.turn; } n.turn = s.turn ^ 1; return n; },
    _line: function (b, p) { return ACHI_LINES.some(function (a) { return b[a[0]] === p && b[a[1]] === p && b[a[2]] === p; }); },
    result: function (s) {
      if (Achi._line(s.b, 0)) return { over: true, winner: 0 };
      if (Achi._line(s.b, 1)) return { over: true, winner: 1 };
      if (s.ply >= 120) return { over: true, winner: null };
      if (!Achi.legal(s).length) return { over: true, winner: s.turn ^ 1 };
      return null;
    },
    bot: function (s) {
      var legal = Achi.legal(s), me = s.turn, opp = me ^ 1;
      for (var i = 0; i < legal.length; i++) { if (Achi._line(Achi.apply(s, legal[i]).b, me)) return legal[i]; }
      // block
      for (var j = 0; j < legal.length; j++) { var n = Achi.apply(s, legal[j]); var rep = Achi.legal(n).some(function (mm) { return Achi._line(Achi.apply(n, mm).b, opp); }); if (!rep) return legal[j]; }
      return pick(legal);
    },
    view: function (s, api) {
      var sel = api._ck && api._ck.from, legal = api.canMove ? Achi.legal(s) : [];
      var g = el("div", "ge-grid"); g.style.gridTemplateColumns = "repeat(3, 1fr)"; g.style.maxWidth = "230px";
      for (var i = 0; i < 9; i++) (function (i) {
        var c = el("button", "ge-cell ge-big"); c.disabled = true;
        if (s.b[i] != null) c.appendChild(el("span", "ge-disc " + (s.b[i] === 0 ? "p0" : "p1")));
        if (api.canMove) {
          if (s.hand[s.turn] > 0) { if (s.b[i] == null) { c.disabled = false; c.classList.add("ok"); c.addEventListener("click", function () { api.move({ t: "place", to: i }); }); } }
          else if (sel != null) { if (legal.some(function (m) { return m.from === sel && m.to === i; })) { c.disabled = false; c.classList.add("target"); c.addEventListener("click", function () { var f = sel; api._ck = null; api.move({ t: "move", from: f, to: i }); }); } else if (i === sel) { c.disabled = false; c.classList.add("sel"); c.addEventListener("click", function () { api._ck = null; api.rerender(); }); } }
          else if (legal.some(function (m) { return m.from === i; })) { c.disabled = false; c.classList.add("movable"); c.addEventListener("click", function () { api._ck = { from: i }; api.rerender(); }); }
        }
        g.appendChild(c);
      })(i);
      api.board.appendChild(g);
      api.board.appendChild(el("p", "ge-info", s.hand[s.turn] > 0 ? ("Place your pieces — in hand: you " + s.hand[0] + ", " + api.oppName + " " + s.hand[1]) : "Slide a piece to an empty neighbor to line up three."));
    }
  };

  /* ======================================================================= */
  /* 14. Sea Battle (Battleship) — auto-placed fleets, take turns firing     */
  /* ======================================================================= */
  var SBN = 7, SB_SHIPS = [4, 3, 3, 2, 2];
  var SeaBattle = {
    id: "battleship", name: "Sea Battle", tag: "8 min", icon: "⚓",
    blurb: "Fire at the grid to hunt and sink your rival's hidden fleet.",
    init: function () { return { ships: [SeaBattle._place(), SeaBattle._place()], shots: [new Array(SBN * SBN).fill(0), new Array(SBN * SBN).fill(0)], turn: 0 }; },
    _place: function () {
      var g = new Array(SBN * SBN).fill(0), guard = 0;
      SB_SHIPS.forEach(function (len) {
        for (var tries = 0; tries < 500; tries++) {
          var horiz = Math.random() < 0.5, r = (Math.random() * SBN) | 0, c = (Math.random() * SBN) | 0, ok = true, cells = [];
          for (var k = 0; k < len; k++) { var rr = r + (horiz ? 0 : k), cc = c + (horiz ? k : 0); if (rr >= SBN || cc >= SBN) { ok = false; break; } cells.push(rr * SBN + cc); }
          if (!ok) continue;
          if (cells.some(function (i) { return g[i]; })) continue;
          cells.forEach(function (i) { g[i] = 1; }); break;
        }
      });
      return g;
    },
    legal: function (s) { var opp = s.turn ^ 1, m = []; for (var i = 0; i < SBN * SBN; i++) if (!s.shots[s.turn][i]) m.push(i); return m; },
    apply: function (s, i) {
      var n = clone(s), opp = s.turn ^ 1;
      n.shots[s.turn][i] = n.ships[opp][i] ? 2 : 1;   // 2 = hit, 1 = miss
      n.last = i;
      if (!n.ships[opp][i]) n.turn = s.turn ^ 1;       // miss ends turn; hit shoots again
      return n;
    },
    _sunkAll: function (s, target) { for (var i = 0; i < SBN * SBN; i++) if (s.ships[target][i] && s.shots[target ^ 1][i] !== 2) return false; return true; },
    result: function (s) {
      if (SeaBattle._sunkAll(s, 1)) return { over: true, winner: 0 };
      if (SeaBattle._sunkAll(s, 0)) return { over: true, winner: 1 };
      return null;
    },
    bot: function (s) {
      var me = s.turn, shots = s.shots[me], hits = [];
      for (var i = 0; i < SBN * SBN; i++) if (shots[i] === 2) hits.push(i);
      // target mode: fire adjacent to an unfinished hit
      for (var h = 0; h < hits.length; h++) { var i2 = hits[h], r = (i2 / SBN) | 0, c = i2 % SBN; var adj = [[r-1,c],[r+1,c],[r,c-1],[r,c+1]]; for (var a = 0; a < 4; a++) { var rr = adj[a][0], cc = adj[a][1]; if (rr < 0 || rr >= SBN || cc < 0 || cc >= SBN) continue; var t = rr * SBN + cc; if (!shots[t]) return t; } }
      // hunt: parity search
      var cand = []; for (var j = 0; j < SBN * SBN; j++) { if (!shots[j] && (((j % SBN) + ((j / SBN) | 0)) % 2 === 0)) cand.push(j); }
      if (!cand.length) for (var k = 0; k < SBN * SBN; k++) if (!shots[k]) cand.push(k);
      return pick(cand);
    },
    view: function (s, api) {
      var me = api.online ? api.seat : 0; // in practice you are seat 0
      me = 0;
      var opp = 1;
      var wrap = el("div", "ge-sb");
      wrap.appendChild(el("div", "ge-info", "Enemy waters — fire here"));
      var eg = el("div", "ge-grid ge-sb__g"); eg.style.gridTemplateColumns = "repeat(" + SBN + ", 1fr)";
      for (var i = 0; i < SBN * SBN; i++) (function (i) {
        var shot = s.shots[me][i], cell = el("button", "ge-cell ge-sb__c");
        if (shot === 2) { cell.classList.add("hit"); cell.textContent = "✳"; cell.disabled = true; }
        else if (shot === 1) { cell.classList.add("miss"); cell.textContent = "·"; cell.disabled = true; }
        else if (api.canMove) cell.addEventListener("click", function () { api.move(i); });
        else cell.disabled = true;
        eg.appendChild(cell);
      })(i);
      wrap.appendChild(eg);
      wrap.appendChild(el("div", "ge-info", "Your fleet"));
      var yg = el("div", "ge-grid ge-sb__g"); yg.style.gridTemplateColumns = "repeat(" + SBN + ", 1fr)";
      for (var j = 0; j < SBN * SBN; j++) { var cell2 = el("div", "ge-cell ge-sb__c"); if (s.ships[me][j]) cell2.classList.add("ship"); if (s.shots[opp][j] === 2) { cell2.classList.add("hit"); cell2.textContent = "✳"; } else if (s.shots[opp][j] === 1) { cell2.classList.add("miss"); cell2.textContent = "·"; } yg.appendChild(cell2); }
      wrap.appendChild(yg);
      api.board.appendChild(wrap);
    }
  };

  /* ======================================================================= */
  /* 15. Memory (Concentration)                                              */
  /* ======================================================================= */
  var MEM_PAIRS = 8;
  var Memory = {
    id: "memory", name: "Memory", tag: "5 min", icon: "❒",
    blurb: "Flip two cards, keep the matches. Best memory wins.",
    init: function () {
      var vals = []; for (var i = 0; i < MEM_PAIRS; i++) { vals.push(i); vals.push(i); }
      for (var j = vals.length - 1; j > 0; j--) { var k = (Math.random() * (j + 1)) | 0; var t = vals[j]; vals[j] = vals[k]; vals[k] = t; }
      return { cards: vals, taken: new Array(vals.length).fill(-1), turn: 0, score: [0, 0], reveal: [] };
    },
    legal: function (s) {
      var free = []; for (var i = 0; i < s.cards.length; i++) if (s.taken[i] < 0) free.push(i);
      var m = []; for (var a = 0; a < free.length; a++) for (var b = a + 1; b < free.length; b++) m.push({ a: free[a], b: free[b] });
      return m;
    },
    apply: function (s, m) {
      var n = clone(s); n.reveal = [m.a, m.b]; n.seen = n.seen || {};
      if (s.cards[m.a] === s.cards[m.b]) { n.taken[m.a] = s.turn; n.taken[m.b] = s.turn; n.score[s.turn]++; /* go again */ }
      else { n.turn = s.turn ^ 1; }
      return n;
    },
    result: function (s) { return s.taken.every(function (t) { return t >= 0; }) ? { over: true, winner: s.score[0] === s.score[1] ? null : (s.score[0] > s.score[1] ? 0 : 1) } : null; },
    bot: function (s) {
      // remember cards revealed so far this game via reveal history is not stored; approximate: use current reveal + known matches from taken
      var known = {}; // value -> [indices] among face-down that bot has "seen" (only the current reveal pair is knowable here)
      (s.reveal || []).forEach(function (i) { if (s.taken[i] < 0) (known[s.cards[i]] = known[s.cards[i]] || []).push(i); });
      for (var v in known) if (known[v].length >= 2) return { a: known[v][0], b: known[v][1] };
      var free = []; for (var i = 0; i < s.cards.length; i++) if (s.taken[i] < 0) free.push(i);
      // if one is known, pick it plus an unknown; else two random
      var a = free[(Math.random() * free.length) | 0], b = free[(Math.random() * free.length) | 0];
      var g = 0; while (b === a && g++ < 20) b = free[(Math.random() * free.length) | 0];
      return { a: a, b: b };
    },
    view: function (s, api) {
      var wrap = el("div", "ge-mem");
      var g = el("div", "ge-grid"); g.style.gridTemplateColumns = "repeat(4, 1fr)"; g.style.maxWidth = "320px";
      var revealed = {}; (s.reveal || []).forEach(function (i) { revealed[i] = 1; });
      var chosen = api._mem && api._mem.a;
      for (var i = 0; i < s.cards.length; i++) (function (i) {
        var faceUp = s.taken[i] >= 0 || revealed[i] || chosen === i;
        var c = el("button", "ge-cell ge-mem__c" + (s.taken[i] >= 0 ? " taken" : "") + (faceUp ? " up" : ""));
        c.textContent = faceUp ? String.fromCharCode(65 + s.cards[i]) : "";
        if (api.canMove && s.taken[i] < 0 && chosen !== i) { c.addEventListener("click", function () { if (chosen == null) { api._mem = { a: i }; api.rerender(); } else { var a = chosen; api._mem = null; api.move({ a: a, b: i }); } }); }
        else c.disabled = true;
        g.appendChild(c);
      })(i);
      wrap.appendChild(g);
      var sc = el("div", "ge-score"); sc.innerHTML = '<span class="p0">You ' + s.score[0] + '</span><span class="p1">' + api.oppName + ' ' + s.score[1] + '</span>';
      wrap.appendChild(sc);
      api.board.appendChild(wrap);
    }
  };

  /* ======================================================================= */
  /* 16. Go Fish (vs bot)                                                    */
  /* ======================================================================= */
  var GoFish = {
    id: "gofish", name: "Go Fish", tag: "6 min", icon: "🐠",
    blurb: "Ask for ranks, collect four of a kind. Most books wins.",
    init: function () {
      var deck = []; for (var r = 0; r < 13; r++) for (var s = 0; s < 4; s++) deck.push(r);
      for (var j = deck.length - 1; j > 0; j--) { var k = (Math.random() * (j + 1)) | 0; var t = deck[j]; deck[j] = deck[k]; deck[k] = t; }
      var h0 = deck.splice(0, 7), h1 = deck.splice(0, 7);
      var st = { deck: deck, hands: [h0, h1], books: [0, 0], turn: 0, log: "" };
      GoFish._pull(st, 0); GoFish._pull(st, 1);
      return st;
    },
    _pull: function (s, p) { for (var r = 0; r < 13; r++) { if (s.hands[p].filter(function (x) { return x === r; }).length === 4) { s.hands[p] = s.hands[p].filter(function (x) { return x !== r; }); s.books[p]++; } } },
    _ranks: function (hand) { var set = {}; hand.forEach(function (r) { set[r] = 1; }); return Object.keys(set).map(Number); },
    legal: function (s) { return GoFish._ranks(s.hands[s.turn]).map(function (r) { return { rank: r }; }); },
    apply: function (s, m) {
      var n = clone(s), me = s.turn, opp = me ^ 1, rank = m.rank;
      var give = n.hands[opp].filter(function (x) { return x === rank; }).length;
      if (give > 0) {
        n.hands[opp] = n.hands[opp].filter(function (x) { return x !== rank; });
        for (var g = 0; g < give; g++) n.hands[me].push(rank);
        n.log = (me === 0 ? "You" : api0(n)) + " asked for " + RK(rank) + " — got " + give + ". Go again.";
        GoFish._pull(n, me);
        // same player continues (turn unchanged)
      } else {
        // go fish
        if (n.deck.length) { var drew = n.deck.shift(); n.hands[me].push(drew); n.log = (me === 0 ? "You" : "Bot") + " asked for " + RK(rank) + " — Go Fish."; if (drew === rank) { n.log += " Drew it! Go again."; GoFish._pull(n, me); return n; } }
        else n.log = "No cards left in the pond.";
        GoFish._pull(n, me);
        n.turn = me ^ 1;
      }
      if (!n.hands[me].length && n.deck.length) { n.hands[me].push(n.deck.shift()); }
      return n;
    },
    result: function (s) {
      if (s.books[0] + s.books[1] >= 13) return { over: true, winner: s.books[0] === s.books[1] ? null : (s.books[0] > s.books[1] ? 0 : 1) };
      if (!s.hands[0].length && !s.hands[1].length && !s.deck.length) return { over: true, winner: s.books[0] === s.books[1] ? null : (s.books[0] > s.books[1] ? 0 : 1) };
      // if current player has no cards and can't draw, pass handled by making legal empty -> treat as over by book count
      if (!GoFish.legal(s).length) return { over: true, winner: s.books[0] === s.books[1] ? null : (s.books[0] > s.books[1] ? 0 : 1) };
      return null;
    },
    bot: function (s) { var ranks = GoFish._ranks(s.hands[s.turn]); return { rank: pick(ranks) }; },
    view: function (s, api) {
      var wrap = el("div", "ge-gofish");
      wrap.appendChild(el("div", "ge-info", api.oppName + " · " + s.hands[1].length + " cards · " + s.books[1] + " books"));
      wrap.appendChild(el("div", "ge-info", "Pond: " + s.deck.length + " cards"));
      wrap.appendChild(el("div", "ge-info ge-gofish__you", "You · " + s.books[0] + " books"));
      var counts = {}; s.hands[0].forEach(function (r) { counts[r] = (counts[r] || 0) + 1; });
      var hand = el("div", "ge-gofish__hand");
      Object.keys(counts).map(Number).sort(function (a, b) { return a - b; }).forEach(function (r) {
        var b = el("button", "ge-gofish__card", RK(r) + (counts[r] > 1 ? " ×" + counts[r] : ""));
        if (api.canMove) b.addEventListener("click", function () { api.move({ rank: r }); }); else b.disabled = true;
        hand.appendChild(b);
      });
      wrap.appendChild(hand);
      if (s.log) wrap.appendChild(el("p", "ge-info", s.log));
      api.board.appendChild(wrap);
    }
  };
  function RK(r) { return ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"][r]; }
  function api0() { return "Bot"; }

  /* ======================================================================= */
  /* 17. Pig — press-your-luck dice to 100                                   */
  /* ======================================================================= */
  var Pig = {
    id: "pig", name: "Pig", tag: "4 min", icon: "⚄",
    blurb: "Roll to build points, but a 1 wipes your turn. First to 100.",
    init: function () { return { score: [0, 0], turn: 0, pending: 0, lastRoll: null }; },
    legal: function (s) { return [{ t: "roll" }, { t: "hold" }]; },
    apply: function (s, m) {
      var n = clone(s);
      if (m.t === "hold") { n.score[s.turn] += s.pending; n.pending = 0; n.lastRoll = null; n.turn = s.turn ^ 1; return n; }
      var d = 1 + ((Math.random() * 6) | 0); n.lastRoll = d;
      if (d === 1) { n.pending = 0; n.turn = s.turn ^ 1; } else n.pending = s.pending + d;
      return n;
    },
    result: function (s) { if (s.score[0] >= 100) return { over: true, winner: 0 }; if (s.score[1] >= 100) return { over: true, winner: 1 }; return null; },
    bot: function (s) { if (s.pending >= 20 || s.score[1] + s.pending >= 100) return { t: "hold" }; return { t: "roll" }; },
    view: function (s, api) {
      var wrap = el("div", "ge-pig");
      var sc = el("div", "ge-score ge-pig__sc"); sc.innerHTML = '<span class="p0">You ' + s.score[0] + '</span><span class="p1">' + api.oppName + ' ' + s.score[1] + '</span>';
      wrap.appendChild(sc);
      var die = el("div", "ge-pig__die", s.lastRoll ? ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][s.lastRoll - 1] : "—"); wrap.appendChild(die);
      wrap.appendChild(el("div", "ge-info", "This turn: " + s.pending + " pending"));
      var acts = el("div", "ge-pig__acts");
      var roll = el("button", "btn btn--cta", "Roll"); var hold = el("button", "btn", "Hold (+" + s.pending + ")");
      if (api.canMove) { roll.addEventListener("click", function () { api.move({ t: "roll" }); }); hold.addEventListener("click", function () { api.move({ t: "hold" }); }); } else { roll.disabled = true; hold.disabled = true; }
      acts.appendChild(roll); acts.appendChild(hold); wrap.appendChild(acts);
      api.board.appendChild(wrap);
    }
  };

  /* ======================================================================= */
  /* 18. Dominoes — draw double-six, 2 players                               */
  /* ======================================================================= */
  var Dominoes = {
    id: "dominoes", name: "Dominoes", tag: "8 min", icon: "🁫",
    blurb: "Match the ends of the chain. First to empty their hand wins.",
    init: function () {
      var set = []; for (var a = 0; a <= 6; a++) for (var b = a; b <= 6; b++) set.push([a, b]);
      for (var j = set.length - 1; j > 0; j--) { var k = (Math.random() * (j + 1)) | 0; var t = set[j]; set[j] = set[k]; set[k] = t; }
      var h0 = set.splice(0, 7), h1 = set.splice(0, 7);
      return { hands: [h0, h1], stock: set, chain: [], left: null, right: null, turn: 0, passes: 0, log: "" };
    },
    _playable: function (tile, s) { if (s.chain.length === 0) return true; return tile[0] === s.left || tile[1] === s.left || tile[0] === s.right || tile[1] === s.right; },
    legal: function (s) {
      var hand = s.hands[s.turn], m = [];
      hand.forEach(function (tile, idx) {
        if (s.chain.length === 0) { m.push({ idx: idx, end: "r" }); return; }
        if (tile[0] === s.left || tile[1] === s.left) m.push({ idx: idx, end: "l" });
        if (tile[0] === s.right || tile[1] === s.right) m.push({ idx: idx, end: "r" });
      });
      if (!m.length) m.push({ t: "draw_or_pass" });
      return m;
    },
    apply: function (s, m) {
      var n = clone(s), me = s.turn, hand = n.hands[me];
      if (m.t === "draw_or_pass") {
        if (n.stock.length) { var d = n.stock.shift(); hand.push(d); n.log = (me === 0 ? "You draw" : "Bot draws") + " a tile."; if (Dominoes._playable(d, n)) return n; return applyPassIfStuck(n, me); }
        n.log = (me === 0 ? "You pass" : "Bot passes") + "."; n.passes++; n.turn = me ^ 1; return n;
      }
      var tile = hand.splice(m.idx, 1)[0];
      if (n.chain.length === 0) { n.chain = [tile.slice()]; n.left = tile[0]; n.right = tile[1]; }
      else if (m.end === "l") { var t2 = tile[1] === n.left ? tile.slice() : [tile[1], tile[0]]; n.chain.unshift(t2); n.left = t2[0]; }
      else { var t3 = tile[0] === n.right ? tile.slice() : [tile[1], tile[0]]; n.chain.push(t3); n.right = t3[1]; }
      n.passes = 0; n.log = (me === 0 ? "You play " : "Bot plays ") + tile[0] + "|" + tile[1] + ".";
      if (!hand.length) { n._winner = me; return n; }
      n.turn = me ^ 1; return n;
    },
    result: function (s) {
      if (s._winner != null) return { over: true, winner: s._winner };
      if (s.passes >= 2 || (!s.stock.length && !Dominoes.legal(s).length)) {
        var p0 = s.hands[0].reduce(function (a, t) { return a + t[0] + t[1]; }, 0);
        var p1 = s.hands[1].reduce(function (a, t) { return a + t[0] + t[1]; }, 0);
        return { over: true, winner: p0 === p1 ? null : (p0 < p1 ? 0 : 1) };
      }
      return null;
    },
    bot: function (s) {
      var hand = s.hands[s.turn];
      var legal = Dominoes.legal(s).filter(function (m) { return m.idx != null; });
      if (!legal.length) return { t: "draw_or_pass" };
      // play the heaviest tile
      legal.sort(function (a, b) { var ta = hand[a.idx], tb = hand[b.idx]; return (tb[0] + tb[1]) - (ta[0] + ta[1]); });
      return legal[0];
    },
    view: function (s, api) {
      var wrap = el("div", "ge-dom");
      wrap.appendChild(el("div", "ge-info", api.oppName + " · " + s.hands[1].length + " tiles · stock " + s.stock.length));
      var chain = el("div", "ge-dom__chain");
      if (!s.chain.length) chain.appendChild(el("span", "ge-info", "Empty board — play any tile."));
      else s.chain.forEach(function (t) { var d = el("span", "ge-dom__tile", t[0] + "|" + t[1]); chain.appendChild(d); });
      wrap.appendChild(chain);
      if (s.chain.length) wrap.appendChild(el("div", "ge-info", "Ends: " + s.left + " and " + s.right));
      wrap.appendChild(el("div", "ge-info ge-gofish__you", "You · " + s.hands[0].length + " tiles"));
      var legal = api.canMove ? Dominoes.legal(s) : [];
      var canPlay = legal.some(function (m) { return m.idx != null; });
      var hand = el("div", "ge-dom__hand");
      s.hands[0].forEach(function (tile, idx) {
        var opts = legal.filter(function (m) { return m.idx === idx; });
        var b = el("button", "ge-dom__tile" + (opts.length ? " ok" : ""), tile[0] + "|" + tile[1]);
        if (api.canMove && opts.length) b.addEventListener("click", function () { if (opts.length === 1) api.move(opts[0]); else { /* both ends: default right, offer left via long-press? keep simple: pick left then right toggle */ api.move(opts.find(function (o) { return o.end === "r"; }) || opts[0]); } });
        else b.disabled = true;
        hand.appendChild(b);
      });
      wrap.appendChild(hand);
      if (api.canMove && !canPlay) { var draw = el("button", "btn btn--cta", s.stock.length ? "Draw a tile" : "Pass"); draw.addEventListener("click", function () { api.move({ t: "draw_or_pass" }); }); wrap.appendChild(draw); }
      if (s.log) wrap.appendChild(el("p", "ge-info", s.log));
      api.board.appendChild(wrap);
    }
  };
  function applyPassIfStuck(n, me) { return n; }

  /* ======================================================================= */
  /* 19. Oware (Mancala variant, capture on 2 or 3)                          */
  /* ======================================================================= */
  var Oware = {
    id: "oware", name: "Oware", tag: "6 min", icon: "◕",
    blurb: "African mancala. Sow seeds, capture the far pits at 2 or 3.",
    init: function () { return { p: [4,4,4,4,4,4, 4,4,4,4,4,4], store: [0, 0], turn: 0, ply: 0 }; },
    _mine: function (t) { return t === 0 ? [0,1,2,3,4,5] : [6,7,8,9,10,11]; },
    legal: function (s) { return Oware._mine(s.turn).filter(function (i) { return s.p[i] > 0; }).map(function (i) { return i; }); },
    apply: function (s, i) {
      var n = clone(s), seeds = n.p[i], idx = i; n.p[i] = 0; n.ply++;
      while (seeds > 0) { idx = (idx + 1) % 12; if (idx === i) continue; n.p[idx]++; seeds--; }
      // capture: if last seed lands in opponent row and makes 2 or 3, capture back along the row
      var oppRow = s.turn === 0 ? [6,7,8,9,10,11] : [0,1,2,3,4,5];
      if (oppRow.indexOf(idx) >= 0) {
        var j = idx;
        while (oppRow.indexOf(j) >= 0 && (n.p[j] === 2 || n.p[j] === 3)) { n.store[s.turn] += n.p[j]; n.p[j] = 0; j = (j - 1 + 12) % 12; }
      }
      n.turn = s.turn ^ 1;
      // if next player has no seeds, current sweeps (simplified end)
      var nextMine = Oware._mine(n.turn);
      if (nextMine.every(function (k) { return n.p[k] === 0; })) { Oware._sweep(n); }
      return n;
    },
    _sweep: function (n) { for (var i = 0; i < 6; i++) { n.store[0] += n.p[i]; n.p[i] = 0; } for (var j = 6; j < 12; j++) { n.store[1] += n.p[j]; n.p[j] = 0; } n.done = true; },
    result: function (s) {
      if (s.ply >= 400) { var a = s.store[0], b = s.store[1]; return { over: true, winner: a === b ? null : (a > b ? 0 : 1) }; }
      if (s.store[0] > 24) return { over: true, winner: 0 };
      if (s.store[1] > 24) return { over: true, winner: 1 };
      if (s.done || (s.store[0] === 24 && s.store[1] === 24)) return { over: true, winner: s.store[0] === s.store[1] ? null : (s.store[0] > s.store[1] ? 0 : 1) };
      if (!Oware.legal(s).length) { var n = clone(s); Oware._sweep(n); return { over: true, winner: n.store[0] === n.store[1] ? null : (n.store[0] > n.store[1] ? 0 : 1) }; }
      return null;
    },
    bot: function (s) {
      var legal = Oware.legal(s), me = s.turn, best = legal[0], bv = -1e9;
      for (var i = 0; i < legal.length; i++) { var n = Oware.apply(s, legal[i]); var sc = (n.store[me] - s.store[me]) + Math.random(); if (sc > bv) { bv = sc; best = legal[i]; } }
      return best;
    },
    view: function (s, api) {
      var legalSet = {}; if (api.canMove) Oware.legal(s).forEach(function (i) { legalSet[i] = 1; });
      var wrap = el("div", "gg-man");
      var os = el("div", "gg-man__store"); os.appendChild(pit(null, "store p1", s.store[1])); wrap.appendChild(os);
      var mid = el("div", "gg-man__mid");
      var top = el("div", "gg-man__row"); for (var i = 11; i >= 6; i--) top.appendChild(pit(i, "p1", s.p[i]));
      var bot = el("div", "gg-man__row"); for (var j = 0; j <= 5; j++) bot.appendChild(pit(j, "p0", s.p[j]));
      mid.appendChild(top); mid.appendChild(bot); wrap.appendChild(mid);
      var ms = el("div", "gg-man__store"); ms.appendChild(pit(null, "store p0", s.store[0])); wrap.appendChild(ms);
      api.board.appendChild(wrap);
      api.board.appendChild(el("p", "ge-info", "Sow from one of your pits. Landing the last seed on an opponent pit of 2 or 3 captures it."));
      function pit(i, cls, val) { var b = el("button", "gg-man__pit " + cls); b.innerHTML = '<span class="v">' + val + '</span>'; if (i != null && legalSet[i]) { b.classList.add("ok"); b.addEventListener("click", function () { api.move(i); }); } else b.disabled = true; return b; }
    }
  };

  /* ======================================================================= */
  /* 20. Fifteen — pick numbers 1-9, first to make 15 with three wins        */
  /* ======================================================================= */
  var Fifteen = {
    id: "fifteen", name: "Fifteen", tag: "3 min", icon: "⑮",
    blurb: "Take turns claiming 1-9. First to hold three that sum to 15 wins.",
    init: function () { return { taken: {}, mine: [[], []], turn: 0 }; }, // taken[n]=0/1
    legal: function (s) { var m = []; for (var n = 1; n <= 9; n++) if (s.taken[n] == null) m.push(n); return m; },
    apply: function (s, n) { var st = clone(s); st.taken[n] = s.turn; st.mine[s.turn].push(n); st.turn = s.turn ^ 1; return st; },
    _has15: function (nums) { for (var a = 0; a < nums.length; a++) for (var b = a + 1; b < nums.length; b++) for (var c = b + 1; c < nums.length; c++) if (nums[a] + nums[b] + nums[c] === 15) return true; return false; },
    result: function (s) {
      if (Fifteen._has15(s.mine[0])) return { over: true, winner: 0 };
      if (Fifteen._has15(s.mine[1])) return { over: true, winner: 1 };
      return Object.keys(s.taken).length >= 9 ? { over: true, winner: null } : null;
    },
    bot: function (s) { return bestBy(Fifteen, s, 9); },
    view: function (s, api) {
      var wrap = el("div", "ge-fifteen");
      var g = el("div", "ge-grid"); g.style.gridTemplateColumns = "repeat(3, 1fr)"; g.style.maxWidth = "230px";
      for (var n = 1; n <= 9; n++) (function (n) {
        var owner = s.taken[n];
        var c = el("button", "ge-cell ge-big", String(n));
        if (owner != null) { c.classList.add(owner === 0 ? "p0" : "p1"); c.disabled = true; }
        else if (api.canMove) c.addEventListener("click", function () { api.move(n); }); else c.disabled = true;
        g.appendChild(c);
      })(n);
      wrap.appendChild(g);
      wrap.appendChild(el("p", "ge-info", "Yours: " + (s.mine[0].join(", ") || "—") + " · " + api.oppName + ": " + (s.mine[1].join(", ") || "—")));
      api.board.appendChild(wrap);
    }
  };

  /* ======================================================================= */
  /* 21. Kayles — a row of pins; knock down 1 or 2 adjacent. Last pin wins.  */
  /* ======================================================================= */
  var Kayles = {
    id: "kayles", name: "Kayles", tag: "3 min", icon: "🎳",
    blurb: "Knock down one pin, or two side by side. Take the last and win.",
    init: function () { return { pins: new Array(12).fill(1), turn: 0 }; },
    legal: function (s) {
      var m = [];
      for (var i = 0; i < s.pins.length; i++) if (s.pins[i]) m.push({ a: i });
      for (var j = 0; j < s.pins.length - 1; j++) if (s.pins[j] && s.pins[j + 1]) m.push({ a: j, b: j + 1 });
      return m;
    },
    apply: function (s, m) { var n = clone(s); n.pins[m.a] = 0; if (m.b != null) n.pins[m.b] = 0; n.turn = s.turn ^ 1; return n; },
    result: function (s) { return s.pins.every(function (p) { return !p; }) ? { over: true, winner: s.turn ^ 1 } : null; }, // last to knock down wins => previous mover
    bot: function (s) {
      // Grundy-based optimal for Kayles (normal play)
      var G = Kayles._grundyAll(s.pins);
      var legal = Kayles.legal(s);
      for (var i = 0; i < legal.length; i++) { var n = Kayles.apply(s, legal[i]); if (Kayles._position(n.pins) === 0) return legal[i]; }
      return pick(legal);
    },
    _position: function (pins) {
      // xor of grundy of each maximal run length
      var runs = [], c = 0; for (var i = 0; i <= pins.length; i++) { if (pins[i]) c++; else { if (c) runs.push(c); c = 0; } }
      var x = 0; runs.forEach(function (L) { x ^= Kayles._grundy(L); }); return x;
    },
    _gcache: { 0: 0 },
    _grundy: function (n) {
      if (Kayles._gcache[n] != null) return Kayles._gcache[n];
      var reach = {};
      for (var i = 0; i < n; i++) { reach[Kayles._grundy(i) ^ Kayles._grundy(n - 1 - i)] = 1; }        // remove 1 pin at position i
      for (var j = 0; j < n - 1; j++) { reach[Kayles._grundy(j) ^ Kayles._grundy(n - 2 - j)] = 1; }    // remove 2 adjacent
      var g = 0; while (reach[g]) g++; Kayles._gcache[n] = g; return g;
    },
    _grundyAll: function () { return 0; },
    view: function (s, api) {
      var sel = api._k && api._k.a;
      var wrap = el("div", "ge-kayles");
      var row = el("div", "ge-kayles__row");
      for (var i = 0; i < s.pins.length; i++) (function (i) {
        var b = el("button", "ge-kayles__pin" + (s.pins[i] ? "" : " down") + (sel === i ? " sel" : ""));
        b.textContent = s.pins[i] ? "🎳" : "";
        if (api.canMove && s.pins[i]) {
          b.addEventListener("click", function () {
            if (sel == null) { api._k = { a: i }; api.rerender(); }
            else if (sel === i) { api._k = null; api.move({ a: i }); }               // click same pin again = take just it
            else if (Math.abs(sel - i) === 1) { var a = Math.min(sel, i); api._k = null; api.move({ a: a, b: a + 1 }); }
            else { api._k = { a: i }; api.rerender(); }
          });
        } else b.disabled = true;
        row.appendChild(b);
      })(i);
      wrap.appendChild(row);
      wrap.appendChild(el("p", "ge-info", sel == null ? "Tap a pin to take it, or tap two neighbors to take both." : "Tap the same pin again to take just it, or a neighbor to take both."));
      api.board.appendChild(wrap);
    }
  };

  /* ---- register everything, attaching _mod for the shared grid view ------- */
  var ALL = [Gomoku, Dots, Morris, Nim, Chomp, OrderChaos, Misere, UTTT, Hexapawn, Breakthrough, Domineering, PongHau, Achi, SeaBattle, Memory, GoFish, Pig, Dominoes, Oware, Fifteen, Kayles];
  ALL.forEach(function (mod) {
    var origView = mod.view;
    mod.view = function (s, api) { api._mod = mod; return origView(s, api); };
    R.register(mod);
  });
  R.finishCatalog();
})();
