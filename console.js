/* ============================================================================
 * Runinback — console (dashboard) logic.
 * Convenience gate + real data. The client-side redirect is only UX; the real
 * authorization boundary is Row Level Security in Postgres, and every balance
 * move goes through SECURITY DEFINER RPC functions (atomic escrow).
 * TEST MODE: the balance is simulated; real money will be non-custodial,
 * on-chain on Base (contracts + audit, Phase 3+).
 *
 * rcoin: 1 rcoin = 1 USD = 100 cents. The wallet stores cents; the UI shows
 * rcoin. The 5% commission is charged once, on the way in (buying rcoin), and
 * shown as a clear rate. Withdrawals are 1:1 with no exit fee.
 * ========================================================================== */
(function () {
  "use strict";

  var A = window.RuninbackAuth;
  var loading = document.getElementById("console-loading");
  var app = document.getElementById("capp");

  function toLanding() { window.location.replace("index.html"); }
  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }
  function msg(el, text, ok) {
    if (!el) return;
    el.textContent = text;
    el.className = "msg " + (ok ? "msg--ok" : "msg--err");
    el.hidden = false;
  }
  function money(cents) { return "$" + ((Number(cents) || 0) / 100).toFixed(2); }
  function rcoin(cents) { return Math.round((Number(cents) || 0) / 100); }
  function rc(cents) { return rcoin(cents) + " rcoin"; }
  function centsFromDollars(v) { var n = parseFloat(String(v).replace(",", ".")); return isFinite(n) ? Math.round(n * 100) : NaN; }
  function centsFromRcoin(v) { var n = parseFloat(String(v).replace(",", ".")); return isFinite(n) ? Math.round(n) * 100 : NaN; }
  function fmtDate(s) {
    if (!s) return "—";
    try { return new Date(s).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" }); }
    catch (e) { return "—"; }
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  }); }

  if (!A) { toLanding(); return; }
  if (!A.configured) {
    if (loading) loading.innerHTML =
      '<p class="muted">The backend isn\'t connected yet. Set SUPABASE_URL and SUPABASE_ANON_KEY in the Vercel environment variables.</p>';
    return;
  }

  var client = A.getClient();
  var UID = null;
  var handleCache = {}; // uuid -> username
  var gamesReady = false;

  A.getSession().then(function (session) {
    if (!session) { toLanding(); return; }
    UID = session.user.id;
    handleCache[UID] = "you";
    if (loading) loading.style.display = "none";
    show(app, true);

    var u = session.user || {};
    var meta = u.user_metadata || {};
    $("acct-name").textContent = meta.username ? "@" + meta.username : (u.email || "");
    $("acct-email").textContent = u.email || "";

    wireNav(); wireChrome(); wireChips();
    wireProfile(); wireProjects(); wireKeys();
    wireRetos(); wireTorneos(); wireWallet(); wireDevRetiros();

    refreshWallet();
    loadProfile();
    loadGames();
  }).catch(function () { toLanding(); });

  /* ---- navigation --------------------------------------------------------- */
  var loaders = {
    "j-games": loadGames,
    "j-compete": function () { loadRetos(); loadTorneos(); },
    "j-cartera": function () { refreshWallet(); loadLedger(); },
    "j-perfil": loadProfile,
    "d-portal": function () { loadProjects(); loadKeys(); loadDevMetrics(); refreshWallet(); }
  };
  function wireNav() {
    document.querySelectorAll("[data-page]").forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); gotoPage(a.getAttribute("data-page")); });
    });
  }
  function gotoPage(id) {
    if (!id) return;
    document.querySelectorAll(".capp .page").forEach(function (p) { p.hidden = p.id !== id; });
    // reflect the active destination on every nav surface (top tabs + bottom nav)
    document.querySelectorAll(".capp__tabs a[data-page], .capp__bnav a[data-page]").forEach(function (a) {
      if (a.getAttribute("data-page") === id) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    closeAcctMenu();
    if (loaders[id]) loaders[id]();
    window.scrollTo(0, 0);
  }

  /* ---- chrome: account menu, dev switch, compete + dev sub-nav ------------ */
  function closeAcctMenu() {
    var m = $("acct-menu"), a = $("acct-avatar");
    if (m) m.hidden = true;
    if (a) a.setAttribute("aria-expanded", "false");
  }
  function wireChrome() {
    var avatar = $("acct-avatar"), menu = $("acct-menu");
    if (avatar && menu) {
      avatar.addEventListener("click", function (e) {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
        avatar.setAttribute("aria-expanded", String(!menu.hidden));
      });
      menu.addEventListener("click", function (e) { e.stopPropagation(); });
      document.addEventListener("click", closeAcctMenu);
    }
    if ($("to-dev")) $("to-dev").addEventListener("click", function () { gotoPage("d-portal"); });
    if ($("to-player")) $("to-player").addEventListener("click", function () { gotoPage("j-games"); });

    // Compete: challenges / tournaments segment
    document.querySelectorAll("#compete-seg button[data-seg]").forEach(function (b) {
      b.addEventListener("click", function () {
        var which = b.getAttribute("data-seg");
        document.querySelectorAll("#compete-seg button").forEach(function (x) {
          x.setAttribute("aria-selected", String(x === b));
        });
        show($("c-challenges"), which === "challenges");
        show($("c-tourneys"), which === "tourneys");
      });
    });

    // Dev sub-nav: projects / keys / payouts
    document.querySelectorAll("#dev-nav a[data-dev]").forEach(function (a) {
      a.addEventListener("click", function () {
        var which = a.getAttribute("data-dev");
        document.querySelectorAll("#dev-nav a").forEach(function (x) {
          if (x === a) x.setAttribute("aria-current", "page"); else x.removeAttribute("aria-current");
        });
        show($("d-projects"), which === "projects");
        show($("d-keys"), which === "keys");
        show($("d-payouts"), which === "payouts");
      });
    });
  }

  /* ---- games -------------------------------------------------------------- */
  function loadGames() {
    if (!window.RIBGames) { $("games-root").innerHTML = '<p class="muted">Could not load games.</p>'; return; }
    if (!gamesReady) {
      window.RIBGames.init({ client: client, UID: UID, refreshWallet: refreshWallet, configured: true });
      gamesReady = true;
    } else {
      window.RIBGames.init({ client: client, UID: UID, refreshWallet: refreshWallet, configured: true });
    }
  }

  /* ---- amount chips ------------------------------------------------------- */
  function wireChips() {
    document.querySelectorAll("[data-chips]").forEach(function (group) {
      group.addEventListener("click", function (e) {
        var b = e.target.closest("button[data-amt]"); if (!b) return;
        group.querySelectorAll("button").forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
        if (group.getAttribute("data-chips") === "buy-amt") {
          $("buy-usd").value = String(parseInt(b.getAttribute("data-amt"), 10) / 100);
          calcBuy();
        }
      });
    });
  }
  function chipAmount(name) {
    var g = document.querySelector('[data-chips="' + name + '"]');
    var on = g && g.querySelector("button.on");
    return on ? parseInt(on.getAttribute("data-amt"), 10) : NaN;
  }

  /* ---- handles (usernames for other players) ------------------------------ */
  function fetchHandles(ids) {
    var need = (ids || []).filter(function (id) { return id && !(id in handleCache); });
    need = need.filter(function (v, i) { return need.indexOf(v) === i; });
    if (!need.length) return Promise.resolve(handleCache);
    return client.from("profiles").select("id, username").in("id", need).then(function (r) {
      (r.data || []).forEach(function (p) { handleCache[p.id] = p.username; });
      need.forEach(function (id) { if (!(id in handleCache)) handleCache[id] = "player"; });
      return handleCache;
    });
  }
  function name(id) { return id ? (id === UID ? "you" : ("@" + (handleCache[id] || "player"))) : "—"; }

  /* ---- wallet ------------------------------------------------------------- */
  function refreshWallet() {
    return client.from("wallets").select("test_balance_cents, test_locked_cents").eq("user_id", UID).single()
      .then(function (r) {
        var w = r.data || { test_balance_cents: 0, test_locked_cents: 0 };
        $("wallet-chip").textContent = rc(w.test_balance_cents);
        if ($("games-bal")) $("games-bal").innerHTML = rcoin(w.test_balance_cents) + ' <small>rcoin</small>';
        if ($("wal-balance")) $("wal-balance").textContent = rc(w.test_balance_cents);
        if ($("wal-locked")) $("wal-locked").textContent = "In play: " + rc(w.test_locked_cents);
        if ($("wal-usd")) $("wal-usd").textContent = money(w.test_balance_cents);
        if ($("sum-balance")) $("sum-balance").textContent = rc(w.test_balance_cents);
        if ($("sum-locked")) $("sum-locked").textContent = w.test_locked_cents > 0 ? ("In play: " + rc(w.test_locked_cents)) : "Nothing at stake";
        if ($("dev-balance")) $("dev-balance").textContent = rc(w.test_balance_cents);
        return w;
      });
  }
  function loadLedger() {
    client.from("wallet_ledger").select("kind, amount_cents, balance_after_cents, memo, created_at").order("created_at", { ascending: false }).limit(40)
      .then(function (r) {
        var box = $("wal-ledger");
        var rows = r.data || [];
        if (r.error) { box.innerHTML = '<p class="muted">Couldn\'t load your activity.</p>'; return; }
        if (!rows.length) { box.innerHTML = '<div class="empty"><h3>No activity yet</h3><p>Buy some rcoin to get started.</p></div>'; return; }
        box.innerHTML = '<div class="panel">' + rows.map(function (m) {
          var pos = m.amount_cents >= 0;
          return '<div class="row row--led"><div><div class="row__name">' + esc(m.memo || m.kind) +
            '</div><div class="row__meta">' + fmtDate(m.created_at) + '</div></div>' +
            '<span class="amt ' + (pos ? "pos" : "neg") + '">' + (pos ? "+" : "") + rc(m.amount_cents) + '</span></div>';
        }).join("") + '</div>';
      });
  }
  function calcBuy() {
    var pay = centsFromDollars($("buy-usd").value);
    if (!isFinite(pay) || pay < 0) pay = 0;
    var getC = Math.round(pay * 0.95), feeC = pay - getC, getR = Math.round(getC / 100);
    $("buy-pay").textContent = money(pay);
    $("buy-fee").textContent = money(feeC);
    $("buy-get").textContent = getR + " rcoin";
    $("buy-go").textContent = "Buy " + getR + " rcoin";
    $("buy-go").disabled = getR <= 0;
    return pay;
  }
  function calcWd() {
    var r = parseFloat(String($("wd-amt").value).replace(",", ".")); if (!isFinite(r) || r < 0) r = 0;
    $("wd-get").textContent = "$" + Math.round(r).toFixed(2);
  }
  function wireWallet() {
    if (!$("buy-go")) return;
    $("buy-usd").addEventListener("input", function () {
      document.querySelectorAll('[data-chips="buy-amt"] button').forEach(function (x) { x.classList.remove("on"); });
      calcBuy();
    });
    $("wd-amt").addEventListener("input", calcWd);
    $("wd-dest").addEventListener("change", calcWd);
    calcBuy(); calcWd();

    $("buy-go").addEventListener("click", function () {
      var pay = centsFromDollars($("buy-usd").value);
      if (!isFinite(pay) || pay < 100) { msg($("wal-msg"), "Minimum $1.", false); return; }
      var b = $("buy-go"); b.disabled = true;
      client.rpc("rib_buy_rcoin_test", { p_pay_cents: pay })
        .then(function (r) {
          if (r.error) { msg($("wal-msg"), r.error.message || "Couldn't complete the purchase.", false); return; }
          msg($("wal-msg"), "Purchase complete.", true); refreshWallet(); loadLedger();
        })
        .catch(function () { msg($("wal-msg"), "Network error.", false); })
        .finally(function () { b.disabled = false; calcBuy(); });
    });
    $("wd-go").addEventListener("click", function () {
      var amt = centsFromRcoin($("wd-amt").value);
      if (!isFinite(amt) || amt < 100) { msg($("wal-msg"), "Minimum 1 rcoin.", false); return; }
      var b = $("wd-go"); b.disabled = true;
      client.rpc("rib_withdraw_test", { p_amount_cents: amt })
        .then(function (r) {
          if (r.error) { msg($("wal-msg"), r.error.message || "Couldn't withdraw.", false); return; }
          msg($("wal-msg"), "Withdrawal complete.", true); $("wd-amt").value = ""; calcWd(); refreshWallet(); loadLedger();
        })
        .catch(function () { msg($("wal-msg"), "Network error.", false); })
        .finally(function () { b.disabled = false; });
    });
  }
  function wireDevRetiros() {
    $("dev-wd-go").addEventListener("click", function () {
      var amt = centsFromRcoin($("dev-wd-amt").value);
      if (!isFinite(amt) || amt < 100) { msg($("dev-wd-msg"), "Minimum 1 rcoin.", false); return; }
      var b = $("dev-wd-go"); b.disabled = true;
      client.rpc("rib_withdraw_test", { p_amount_cents: amt })
        .then(function (r) {
          if (r.error) { msg($("dev-wd-msg"), r.error.message || "Couldn't withdraw.", false); return; }
          msg($("dev-wd-msg"), "Withdrawal complete.", true); $("dev-wd-amt").value = ""; refreshWallet();
        })
        .catch(function () { msg($("dev-wd-msg"), "Network error.", false); })
        .finally(function () { b.disabled = false; });
    });
  }

  /* ---- challenge status label --------------------------------------------- */
  function statusLabel(c) {
    return { open: "Open", pending: "Invite", active: "In play", settled: "Finished", disputed: "In dispute", cancelled: "Cancelled" }[c.status] || c.status;
  }

  /* ---- challenges --------------------------------------------------------- */
  function loadRetos() {
    client.from("challenges").select("*")
      .or("creator_id.eq." + UID + ",opponent_id.eq." + UID + ",target_id.eq." + UID)
      .order("created_at", { ascending: false })
      .then(function (r) {
        var rows = (r.data) || [];
        var ids = [];
        rows.forEach(function (c) { ids.push(c.creator_id, c.opponent_id, c.target_id); });
        fetchHandles(ids).then(function () { renderMine(rows); });
      });
    client.from("challenges").select("*").eq("status", "open").neq("creator_id", UID)
      .order("created_at", { ascending: false })
      .then(function (r) {
        var rows = (r.data) || [];
        fetchHandles(rows.map(function (c) { return c.creator_id; })).then(function () { renderOpen(rows); });
      });
  }
  function renderMine(rows) {
    var box = $("reto-mine");
    if (!rows.length) { box.innerHTML = '<div class="empty"><h3>No challenges yet</h3><p>Create one above: set the game and the stake, and leave it open or challenge someone by username.</p></div>'; return; }
    box.innerHTML = '<div class="panel">' + rows.map(function (c) {
      var vs = c.opponent_id ? name(c.opponent_id === UID ? c.creator_id : c.opponent_id)
             : (c.target_id ? name(c.target_id) + " (invited)" : "open");
      return '<div class="row row--reto"><div><div class="row__name">' + esc(c.game) + ' · ' + rc(c.stake_cents) +
        '</div><div class="row__meta">' + esc(c.mode) + ' · vs ' + esc(vs) + ' · ' + statusLabel(c) + '</div></div>' +
        '<div class="row__act">' + retoActions(c) + '</div></div>';
    }).join("") + '</div>';
    wireRowActions(box);
  }
  function renderOpen(rows) {
    var box = $("reto-open");
    if (!rows.length) { box.innerHTML = '<div class="empty"><h3>No open challenges right now</h3><p>Create yours and wait for someone to accept.</p></div>'; return; }
    box.innerHTML = '<div class="panel">' + rows.map(function (c) {
      return '<div class="row row--reto"><div><div class="row__name">' + esc(c.game) + ' · ' + rc(c.stake_cents) +
        '</div><div class="row__meta">' + esc(c.mode) + ' · from ' + esc(name(c.creator_id)) + '</div></div>' +
        '<div class="row__act"><button type="button" class="btn btn--cta btn--sm" data-accept="' + esc(c.id) + '">Accept ' + rc(c.stake_cents) + '</button></div></div>';
    }).join("") + '</div>';
    wireRowActions(box);
  }
  function retoActions(c) {
    var iAmCreator = c.creator_id === UID;
    var myReport = iAmCreator ? c.creator_report : c.opponent_report;
    if (c.status === "open" || c.status === "pending") {
      if (iAmCreator) return '<button type="button" class="btn btn--sm btn--danger" data-cancel="' + esc(c.id) + '">Cancel</button>';
      if (c.target_id === UID) return '<button type="button" class="btn btn--cta btn--sm" data-accept="' + esc(c.id) + '">Accept ' + rc(c.stake_cents) + '</button>';
      return '<span class="tag">pending</span>';
    }
    if (c.status === "active") {
      if (myReport) return '<span class="tag">waiting for opponent</span>';
      return '<button type="button" class="btn btn--sm" data-won="' + esc(c.id) + '">I won</button>' +
             '<button type="button" class="btn btn--sm" data-lost="' + esc(c.id) + '">I lost</button>';
    }
    if (c.status === "settled") return c.winner_id === UID
      ? '<span class="tag" style="color:var(--c-good);border-color:rgba(53,208,127,.4)">won</span>'
      : '<span class="tag revoked">lost</span>';
    if (c.status === "disputed") return '<span class="tag revoked">in dispute</span>';
    return '<span class="tag">' + statusLabel(c) + '</span>';
  }
  function wireRowActions(box) {
    box.querySelectorAll("[data-accept]").forEach(function (b) { b.addEventListener("click", function () { rpcReto("rib_challenge_accept", { p_challenge_id: b.getAttribute("data-accept") }, b); }); });
    box.querySelectorAll("[data-cancel]").forEach(function (b) { b.addEventListener("click", function () { rpcReto("rib_challenge_cancel", { p_challenge_id: b.getAttribute("data-cancel") }, b); }); });
    box.querySelectorAll("[data-won]").forEach(function (b) { b.addEventListener("click", function () { report(b.getAttribute("data-won"), UID, b); }); });
    box.querySelectorAll("[data-lost]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.getAttribute("data-lost");
        client.from("challenges").select("creator_id, opponent_id").eq("id", id).single().then(function (r) {
          if (r.error || !r.data) return;
          var other = r.data.creator_id === UID ? r.data.opponent_id : r.data.creator_id;
          report(id, other, b);
        });
      });
    });
  }
  function report(id, winnerId, btn) { rpcReto("rib_challenge_report", { p_challenge_id: id, p_winner_id: winnerId }, btn); }
  function rpcReto(fn, args, btn) {
    if (btn) btn.disabled = true;
    client.rpc(fn, args).then(function (r) {
      if (r.error) { msg($("reto-msg"), r.error.message || "Couldn't complete the action.", false); if (btn) btn.disabled = false; return; }
      $("reto-msg").hidden = true; loadRetos(); refreshWallet();
    }).catch(function () { if (btn) btn.disabled = false; });
  }
  function wireRetos() {
    var form = $("reto-form");
    $("reto-new").addEventListener("click", function () { show(form, true); $("reto-game").focus(); });
    $("reto-cancel").addEventListener("click", function () { show(form, false); $("reto-msg").hidden = true; });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var game = ($("reto-game").value || "").trim();
      var mode = ($("reto-mode").value || "1v1").trim();
      var stake = chipAmount("reto-stake");
      var target = ($("reto-target").value || "").trim();
      if (!game) { msg($("reto-msg"), "Enter the game.", false); return; }
      if (!isFinite(stake)) { msg($("reto-msg"), "Pick a stake.", false); return; }
      var b = $("reto-save"); b.disabled = true;
      client.rpc("rib_challenge_create", { p_game: game, p_mode: mode, p_stake_cents: stake, p_target_username: target || null })
        .then(function (r) {
          if (r.error) { msg($("reto-msg"), r.error.message || "Couldn't create the challenge.", false); return; }
          show(form, false); $("reto-game").value = ""; $("reto-target").value = "";
          loadRetos(); refreshWallet();
        })
        .catch(function () { msg($("reto-msg"), "Network error.", false); })
        .finally(function () { b.disabled = false; });
    });
  }

  /* ---- tournaments -------------------------------------------------------- */
  function loadTorneos() {
    client.from("tournaments").select("*").order("created_at", { ascending: false }).limit(50)
      .then(function (r) {
        var ts = (r.data) || [];
        if (r.error) { $("tor-list").innerHTML = '<p class="muted">Couldn\'t load tournaments.</p>'; return; }
        if (!ts.length) { $("tor-list").innerHTML = '<div class="empty"><h3>No tournaments yet</h3><p>Create the first one: set the fee and the slots, and the pool builds from entries.</p></div>'; return; }
        var tids = ts.map(function (t) { return t.id; });
        client.from("tournament_entries").select("tournament_id, user_id, placement").in("tournament_id", tids)
          .then(function (er) {
            var entries = (er.data) || [];
            var byT = {};
            entries.forEach(function (e) { (byT[e.tournament_id] = byT[e.tournament_id] || []).push(e); });
            var ids = ts.map(function (t) { return t.creator_id; }).concat(entries.map(function (e) { return e.user_id; }));
            fetchHandles(ids).then(function () { renderTorneos(ts, byT); });
          });
      });
  }
  function renderTorneos(ts, byT) {
    $("tor-list").innerHTML = ts.map(function (t) {
      var es = byT[t.id] || [];
      var mine = es.some(function (e) { return e.user_id === UID; });
      var iAmOrg = t.creator_id === UID;
      var winner = es.filter(function (e) { return e.placement === 1; })[0];
      var act = "";
      if (t.status === "open" && !mine) act = '<button type="button" class="btn btn--cta btn--sm" data-join="' + esc(t.id) + '">Join ' + (t.entry_fee_cents ? rc(t.entry_fee_cents) : "free") + '</button>';
      else if (mine && t.status !== "finished") act = '<span class="tag" style="color:var(--c-good);border-color:rgba(53,208,127,.4)">joined</span>';
      if (iAmOrg && (t.status === "open" || t.status === "full" || t.status === "active") && es.length) {
        act += ' <select class="mini-sel" data-winsel="' + esc(t.id) + '"><option value="">Winner…</option>' +
          es.map(function (e) { return '<option value="' + esc(e.user_id) + '">' + esc(name(e.user_id)) + '</option>'; }).join("") +
          '</select><button type="button" class="btn btn--sm" data-finish="' + esc(t.id) + '">Finish</button>';
      }
      if (t.status === "finished") act = '<span class="tag">won by ' + esc(winner ? name(winner.user_id) : "—") + '</span>';
      return '<div class="tcard"><div class="tcard__top"><div><div class="tcard__name">' + esc(t.name) + '</div>' +
        '<div class="row__meta">' + esc(t.game) + ' · ' + statusTor(t.status) + '</div></div>' +
        '<div class="tcard__pool"><span class="k">pool</span><span class="v">' + rc(t.prize_pool_cents) + '</span></div></div>' +
        '<div class="tcard__mid"><span>Fee ' + (t.entry_fee_cents ? rc(t.entry_fee_cents) : "free") + '</span>' +
        '<span>' + es.length + '/' + t.max_players + ' players</span></div>' +
        '<div class="tcard__act">' + act + '</div></div>';
    }).join("");
    var box = $("tor-list");
    box.querySelectorAll("[data-join]").forEach(function (b) { b.addEventListener("click", function () { rpcTor("rib_tournament_join", { p_tournament_id: b.getAttribute("data-join") }, b); }); });
    box.querySelectorAll("[data-finish]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.getAttribute("data-finish");
        var sel = box.querySelector('[data-winsel="' + id + '"]');
        var w = sel ? sel.value : "";
        if (!w) { msgTor("Pick a winner."); return; }
        rpcTor("rib_tournament_finish", { p_tournament_id: id, p_winner_id: w }, b);
      });
    });
  }
  function statusTor(s) { return { open: "Registration open", full: "Full", active: "In progress", finished: "Finished", cancelled: "Cancelled" }[s] || s; }
  function msgTor(t) { msg($("tor-msg"), t, false); }
  function rpcTor(fn, args, btn) {
    if (btn) btn.disabled = true;
    client.rpc(fn, args).then(function (r) {
      if (r.error) { msgTor(r.error.message || "Couldn't complete the action."); if (btn) btn.disabled = false; return; }
      $("tor-msg").hidden = true; loadTorneos(); refreshWallet();
    }).catch(function () { if (btn) btn.disabled = false; });
  }
  function wireTorneos() {
    var form = $("tor-form");
    $("tor-new").addEventListener("click", function () { show(form, true); $("tor-name").focus(); });
    $("tor-cancel").addEventListener("click", function () { show(form, false); $("tor-msg").hidden = true; });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var nm = ($("tor-name").value || "").trim();
      var game = ($("tor-game").value || "").trim();
      var fee = chipAmount("tor-fee");
      var max = parseInt($("tor-max").value, 10);
      if (!nm) { msgTor("Give the tournament a name."); return; }
      if (!game) { msgTor("Enter the game."); return; }
      if (!isFinite(fee)) fee = 0;
      var b = $("tor-save"); b.disabled = true;
      client.rpc("rib_tournament_create", { p_name: nm, p_game: game, p_entry_fee_cents: fee, p_max_players: max, p_starts_at: null })
        .then(function (r) {
          if (r.error) { msgTor(r.error.message || "Couldn't create."); return; }
          show(form, false); $("tor-name").value = ""; $("tor-game").value = ""; loadTorneos();
        })
        .catch(function () { msgTor("Network error."); })
        .finally(function () { b.disabled = false; });
    });
  }

  /* ---- profile (real: profiles table, RLS owner-only) --------------------- */
  function loadProfile() {
    client.from("profiles").select("username, display_name, role, created_at").eq("id", UID).single()
      .then(function (r) {
        var p = r.data || {};
        $("pf-username").value = p.username || "";
        $("pf-display").value = p.display_name || "";
        $("pf-email").value = ($("acct-email").textContent) || "";
        $("pf-since").value = fmtDate(p.created_at);
        if (p.username) { handleCache[UID] = p.username; $("acct-name").textContent = "@" + p.username; }
      });
  }
  function wireProfile() {
    var form = $("profile-form");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var username = ($("pf-username").value || "").trim();
      var display = ($("pf-display").value || "").trim();
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) { msg($("pf-msg"), "Username: 3–24 characters, letters, numbers or underscore.", false); return; }
      var btn = $("pf-save"); btn.disabled = true;
      client.from("profiles").update({ username: username, display_name: display || null }).eq("id", UID)
        .then(function (r) {
          if (r.error) {
            var m = (r.error.code === "23505") ? "That username is taken." : (r.error.message || "Couldn't save.");
            msg($("pf-msg"), m, false); return;
          }
          msg($("pf-msg"), "Saved.", true);
          handleCache[UID] = username;
          $("acct-name").textContent = "@" + username;
        })
        .catch(function () { msg($("pf-msg"), "Network error. Try again.", false); })
        .finally(function () { btn.disabled = false; });
    });
  }

  /* ---- projects (real: projects table, RLS owner-only) -------------------- */
  function loadProjects() {
    client.from("projects").select("id, name, environment, created_at").order("created_at", { ascending: false })
      .then(function (r) {
        var list = $("proj-list");
        if (r.error) { list.innerHTML = '<p class="muted">Couldn\'t load projects.</p>'; return; }
        var rows = r.data || [];
        fillProjectSelect(rows);
        if (!rows.length) {
          list.innerHTML = '<div class="empty"><h3>No projects yet</h3><p>Create one to group your API keys by game or environment.</p></div>';
          return;
        }
        list.innerHTML = '<div class="panel">' + rows.map(function (p) {
          return '<div class="row row--proj"><div><div class="row__name">' + esc(p.name) +
            '</div><div class="row__meta">' + esc(p.environment) + ' · ' + fmtDate(p.created_at) +
            '</div></div><span class="tag ' + (p.environment === "live" ? "live" : "") + '">' + esc(p.environment) + '</span></div>';
        }).join("") + '</div>';
      });
  }
  function fillProjectSelect(rows) {
    var sel = $("key-project");
    if (!sel) return;
    sel.innerHTML = '<option value="">No project</option>' + (rows || []).map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (' + esc(p.environment) + ')</option>';
    }).join("");
  }
  function wireProjects() {
    var form = $("proj-form");
    $("proj-new").addEventListener("click", function () { show(form, true); $("proj-name").focus(); });
    $("proj-cancel").addEventListener("click", function () { show(form, false); $("proj-msg").hidden = true; });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var nm = ($("proj-name").value || "").trim();
      var env = $("proj-env").value === "live" ? "live" : "test";
      if (nm.length < 1 || nm.length > 80) { msg($("proj-msg"), "Give it a name (1–80 characters).", false); return; }
      var btn = $("proj-save"); btn.disabled = true;
      client.from("projects").insert({ owner_id: UID, name: nm, environment: env }).select().single()
        .then(function (r) {
          if (r.error) { msg($("proj-msg"), r.error.message || "Couldn't create.", false); return; }
          show(form, false); $("proj-name").value = ""; $("proj-msg").hidden = true;
          loadProjects();
        })
        .catch(function () { msg($("proj-msg"), "Network error. Try again.", false); })
        .finally(function () { btn.disabled = false; });
    });
  }

  /* ---- API keys ----------------------------------------------------------- */
  function loadKeys() {
    client.from("api_keys").select("id, name, environment, key_prefix, created_at, revoked_at").order("created_at", { ascending: false })
      .then(function (r) {
        var list = $("key-list");
        if (r.error) { list.innerHTML = '<p class="muted">Couldn\'t load keys.</p>'; return; }
        var rows = r.data || [];
        if (!rows.length) {
          list.innerHTML = '<div class="empty"><h3>No API keys yet</h3><p>Issue one to authenticate your SDK integration. You\'ll see it in full once.</p></div>';
          return;
        }
        list.innerHTML = '<div class="panel">' + rows.map(function (k) {
          var revoked = !!k.revoked_at;
          return '<div class="row row--keys"><div><div class="row__name">' + esc(k.name || "default") +
            '</div><div class="row__meta"><code>' + esc(k.key_prefix) + '…</code> · ' + fmtDate(k.created_at) +
            '</div></div><span class="tag ' + (revoked ? "revoked" : (k.environment === "live" ? "live" : "")) + '">' +
            (revoked ? "revoked" : esc(k.environment)) + '</span>' +
            (revoked ? '' : '<button type="button" class="btn btn--sm btn--danger" data-revoke="' + esc(k.id) + '">Revoke</button>') +
            '</div>';
        }).join("") + '</div>';
        list.querySelectorAll("[data-revoke]").forEach(function (b) {
          b.addEventListener("click", function () { revokeKey(b.getAttribute("data-revoke"), b); });
        });
      });
  }
  function revokeKey(id, btn) {
    btn.disabled = true;
    client.from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", id)
      .then(function () { loadKeys(); })
      .catch(function () { btn.disabled = false; });
  }
  function wireKeys() {
    var form = $("key-form");
    $("key-new").addEventListener("click", function () { show(form, true); $("key-reveal").hidden = true; $("key-name").focus(); });
    $("key-cancel").addEventListener("click", function () { show(form, false); $("key-msg").hidden = true; $("key-reveal").hidden = true; });
    $("key-copy").addEventListener("click", function () {
      var txt = $("key-plaintext").textContent || "";
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { $("key-copy").textContent = "Copied"; }).catch(function () {});
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var nm = ($("key-name").value || "").trim() || "default";
      var env = $("key-env").value === "live" ? "live" : "test";
      var project = $("key-project").value || null;
      var btn = $("key-save"); btn.disabled = true;
      $("key-reveal").hidden = true;
      client.functions.invoke("issue-api-key", { body: { name: nm, environment: env, project_id: project } })
        .then(function (r) {
          if (r.error || !r.data || !r.data.key) { msg($("key-msg"), "Couldn't issue the key. Check that the function is deployed.", false); return; }
          $("key-msg").hidden = true;
          $("key-plaintext").textContent = r.data.key;
          $("key-copy").textContent = "Copy";
          $("key-reveal").hidden = false;
          $("key-name").value = "";
          loadKeys();
        })
        .catch(function () { msg($("key-msg"), "Network error. Try again.", false); })
        .finally(function () { btn.disabled = false; });
    });
  }

  /* ---- dev metrics (real, derived from your account) ---------------------- */
  function loadDevMetrics() {
    client.from("projects").select("id", { count: "exact", head: true }).then(function (r) {
      $("m-projects").textContent = String(r.count || 0);
    });
    client.from("api_keys").select("revoked_at").then(function (r) {
      var rows = r.data || [];
      $("m-keys-total").textContent = String(rows.length);
      $("m-keys").textContent = String(rows.filter(function (k) { return !k.revoked_at; }).length);
    });
  }
})();
