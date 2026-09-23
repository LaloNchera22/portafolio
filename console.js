/* ============================================================================
 * Runinback — console (dashboard) logic.
 * Convenience gate + datos reales. La redirección del cliente es solo UX; la
 * frontera real de autorización es Row Level Security en Postgres, y todo
 * movimiento de saldo pasa por funciones RPC SECURITY DEFINER (escrow atómico).
 * MODO DE PRUEBA: el saldo es simulado; el dinero real será no custodial,
 * on-chain sobre Base (contratos + auditoría, Fase 3+).
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
  function centsFromInput(v) { var n = parseFloat(String(v).replace(",", ".")); return isFinite(n) ? Math.round(n * 100) : NaN; }
  function fmtDate(s) {
    if (!s) return "—";
    try { return new Date(s).toLocaleDateString("es", { year: "numeric", month: "short", day: "numeric" }); }
    catch (e) { return "—"; }
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  }); }

  if (!A) { toLanding(); return; }
  if (!A.configured) {
    if (loading) loading.innerHTML =
      '<p class="muted">El backend aún no está conectado. Configura SUPABASE_URL y SUPABASE_ANON_KEY en las variables de entorno de Vercel.</p>';
    return;
  }

  var client = A.getClient();
  var UID = null;
  var handleCache = {}; // uuid -> username

  A.getSession().then(function (session) {
    if (!session) { toLanding(); return; }
    UID = session.user.id;
    handleCache[UID] = "tú";
    if (loading) loading.style.display = "none";
    show(app, true);

    var u = session.user || {};
    var meta = u.user_metadata || {};
    $("acct-name").textContent = meta.username ? "@" + meta.username : (u.email || "");
    $("acct-email").textContent = u.email || "";

    wireNav(); wirePersona(); wireQuick(); wireChips();
    wireProfile(); wireProjects(); wireKeys();
    wireRetos(); wireTorneos(); wireWallet(); wireDevRetiros();

    refreshWallet();
    loadProfile();
    loadResumen();
  }).catch(function () { toLanding(); });

  /* ---- navigation --------------------------------------------------------- */
  var loaders = {
    "j-resumen": loadResumen,
    "j-retos": loadRetos,
    "j-torneos": loadTorneos,
    "j-cartera": function () { refreshWallet(); loadLedger(); },
    "j-perfil": loadProfile,
    "d-proyectos": loadProjects,
    "d-keys": loadKeys,
    "d-metricas": loadDevMetrics,
    "d-retiros": refreshWallet
  };
  function wireNav() {
    document.querySelectorAll(".capp__menu a[data-page]").forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); gotoPage(a.getAttribute("data-page"), a); });
    });
  }
  function gotoPage(id, link) {
    document.querySelectorAll(".capp .page").forEach(function (p) { p.hidden = p.id !== id; });
    var current = link || document.querySelector('.capp__menu a[data-page="' + id + '"]');
    if (current && current.parentNode) {
      current.parentNode.querySelectorAll("a").forEach(function (a) {
        if (a.getAttribute("data-page") === id) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      });
    }
    if (loaders[id]) loaders[id]();
  }
  function wireQuick() {
    document.querySelectorAll("[data-goto]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.getAttribute("data-goto");
        var dev = id.charAt(0) === "d";
        setPersona(dev);
        gotoPage(id);
      });
    });
  }
  function setPersona(dev) {
    $("tab-player").setAttribute("aria-selected", String(!dev));
    $("tab-dev").setAttribute("aria-selected", String(dev));
    show($("nav-player"), !dev);
    show($("nav-dev"), dev);
  }
  function wirePersona() {
    document.querySelectorAll(".persona button").forEach(function (b) {
      b.addEventListener("click", function () {
        var dev = b.getAttribute("data-persona") === "dev";
        setPersona(dev);
        var first = (dev ? $("nav-dev") : $("nav-player")).querySelector("a[data-page]");
        if (first) gotoPage(first.getAttribute("data-page"), first);
      });
    });
  }

  /* ---- amount chips ------------------------------------------------------- */
  function wireChips() {
    document.querySelectorAll("[data-chips]").forEach(function (group) {
      group.addEventListener("click", function (e) {
        var b = e.target.closest("button[data-amt]"); if (!b) return;
        group.querySelectorAll("button").forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
        if (group.getAttribute("data-chips") === "dep-amt") {
          $("dep-go").textContent = "Ingresar " + money(b.getAttribute("data-amt"));
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
      need.forEach(function (id) { if (!(id in handleCache)) handleCache[id] = "jugador"; });
      return handleCache;
    });
  }
  function name(id) { return id ? (id === UID ? "tú" : ("@" + (handleCache[id] || "jugador"))) : "—"; }

  /* ---- wallet ------------------------------------------------------------- */
  function refreshWallet() {
    return client.from("wallets").select("test_balance_cents, test_locked_cents").eq("user_id", UID).single()
      .then(function (r) {
        var w = r.data || { test_balance_cents: 0, test_locked_cents: 0 };
        $("wallet-chip").textContent = money(w.test_balance_cents);
        if ($("wal-balance")) $("wal-balance").textContent = money(w.test_balance_cents);
        if ($("wal-locked")) $("wal-locked").textContent = "En juego: " + money(w.test_locked_cents);
        if ($("sum-balance")) $("sum-balance").textContent = money(w.test_balance_cents);
        if ($("sum-locked")) $("sum-locked").textContent = w.test_locked_cents > 0 ? ("En juego: " + money(w.test_locked_cents)) : "Sin nada en juego";
        if ($("dev-balance")) $("dev-balance").textContent = money(w.test_balance_cents);
        return w;
      });
  }
  function loadLedger() {
    client.from("wallet_ledger").select("kind, amount_cents, balance_after_cents, memo, created_at").order("created_at", { ascending: false }).limit(40)
      .then(function (r) {
        var box = $("wal-ledger");
        var rows = r.data || [];
        if (r.error) { box.innerHTML = '<p class="muted">No se pudieron cargar los movimientos.</p>'; return; }
        if (!rows.length) { box.innerHTML = '<div class="empty"><h3>Sin movimientos todavía</h3><p>Ingresa saldo de prueba para empezar.</p></div>'; return; }
        box.innerHTML = '<div class="panel">' + rows.map(function (m) {
          var pos = m.amount_cents >= 0;
          return '<div class="row row--led"><div><div class="row__name">' + esc(m.memo || m.kind) +
            '</div><div class="row__meta">' + fmtDate(m.created_at) + '</div></div>' +
            '<span class="amt ' + (pos ? "pos" : "neg") + '">' + (pos ? "+" : "") + money(m.amount_cents) + '</span></div>';
        }).join("") + '</div>';
      });
  }
  function wireWallet() {
    $("dep-go").addEventListener("click", function () {
      var amt = chipAmount("dep-amt");
      if (!isFinite(amt)) { msg($("wal-msg"), "Elige un monto.", false); return; }
      var b = $("dep-go"); b.disabled = true;
      client.rpc("rib_deposit_test", { p_amount_cents: amt })
        .then(function (r) {
          if (r.error) { msg($("wal-msg"), r.error.message || "No se pudo ingresar.", false); return; }
          $("wal-msg").hidden = true; refreshWallet(); loadLedger();
        })
        .catch(function () { msg($("wal-msg"), "Error de red.", false); })
        .finally(function () { b.disabled = false; });
    });
    $("wd-go").addEventListener("click", function () {
      var amt = centsFromInput($("wd-amt").value);
      if (!isFinite(amt) || amt < 100) { msg($("wal-msg"), "Monto mínimo $1.", false); return; }
      var b = $("wd-go"); b.disabled = true;
      client.rpc("rib_withdraw_test", { p_amount_cents: amt })
        .then(function (r) {
          if (r.error) { msg($("wal-msg"), r.error.message || "No se pudo retirar.", false); return; }
          $("wal-msg").hidden = true; $("wd-amt").value = ""; refreshWallet(); loadLedger();
        })
        .catch(function () { msg($("wal-msg"), "Error de red.", false); })
        .finally(function () { b.disabled = false; });
    });
  }
  function wireDevRetiros() {
    $("dev-wd-go").addEventListener("click", function () {
      var amt = centsFromInput($("dev-wd-amt").value);
      if (!isFinite(amt) || amt < 100) { msg($("dev-wd-msg"), "Monto mínimo $1.", false); return; }
      var b = $("dev-wd-go"); b.disabled = true;
      client.rpc("rib_withdraw_test", { p_amount_cents: amt })
        .then(function (r) {
          if (r.error) { msg($("dev-wd-msg"), r.error.message || "No se pudo retirar.", false); return; }
          msg($("dev-wd-msg"), "Retiro realizado.", true); $("dev-wd-amt").value = ""; refreshWallet();
        })
        .catch(function () { msg($("dev-wd-msg"), "Error de red.", false); })
        .finally(function () { b.disabled = false; });
    });
  }

  /* ---- resumen (real aggregates) ------------------------------------------ */
  function loadResumen() {
    refreshWallet();
    var hello = $("j-hello");
    if (hello && handleCache[UID] && handleCache[UID] !== "tú") {} // keep default greeting
    Promise.all([
      client.from("challenges").select("id, status, winner_id, creator_id, opponent_id, game, stake_cents, created_at")
        .or("creator_id.eq." + UID + ",opponent_id.eq." + UID).order("created_at", { ascending: false }),
      client.from("tournament_entries").select("id").eq("user_id", UID)
    ]).then(function (res) {
      var ch = (res[0].data) || [];
      var settled = ch.filter(function (c) { return c.status === "settled"; });
      var won = settled.filter(function (c) { return c.winner_id === UID; });
      $("sum-played").textContent = String(settled.length);
      $("sum-won").textContent = String(won.length);
      $("sum-tourneys").textContent = String(((res[1].data) || []).length);

      var box = $("sum-activity");
      var recent = ch.slice(0, 5);
      if (!recent.length) {
        box.innerHTML = '<div class="empty"><h3>Aún no has jugado</h3><p>Ingresa saldo de prueba y crea tu primer reto para verlo aquí.</p></div>';
        return;
      }
      box.innerHTML = '<div class="panel">' + recent.map(function (c) {
        return '<div class="row row--led"><div><div class="row__name">' + esc(c.game) +
          ' · ' + money(c.stake_cents) + '</div><div class="row__meta">' + statusLabel(c) + ' · ' + fmtDate(c.created_at) +
          '</div></div>' + resultBadge(c) + '</div>';
      }).join("") + '</div>';
    });
  }
  function resultBadge(c) {
    if (c.status === "settled") return c.winner_id === UID
      ? '<span class="amt pos">+' + money(c.stake_cents) + '</span>'
      : '<span class="amt neg">-' + money(c.stake_cents) + '</span>';
    if (c.status === "active") return '<span class="tag">en juego</span>';
    if (c.status === "disputed") return '<span class="tag revoked">disputa</span>';
    if (c.status === "cancelled") return '<span class="tag">cancelado</span>';
    return '<span class="tag">abierto</span>';
  }
  function statusLabel(c) {
    return { open: "Abierto", pending: "Invitación", active: "En juego", settled: "Terminado", disputed: "En disputa", cancelled: "Cancelado" }[c.status] || c.status;
  }

  /* ---- retos PvP ---------------------------------------------------------- */
  function loadRetos() {
    // mis retos: soy creador, rival o destinatario
    client.from("challenges").select("*")
      .or("creator_id.eq." + UID + ",opponent_id.eq." + UID + ",target_id.eq." + UID)
      .order("created_at", { ascending: false })
      .then(function (r) {
        var rows = (r.data) || [];
        var ids = [];
        rows.forEach(function (c) { ids.push(c.creator_id, c.opponent_id, c.target_id); });
        fetchHandles(ids).then(function () { renderMine(rows); });
      });
    // lobby: retos abiertos de otros
    client.from("challenges").select("*").eq("status", "open").neq("creator_id", UID)
      .order("created_at", { ascending: false })
      .then(function (r) {
        var rows = (r.data) || [];
        fetchHandles(rows.map(function (c) { return c.creator_id; })).then(function () { renderOpen(rows); });
      });
  }
  function renderMine(rows) {
    var box = $("reto-mine");
    if (!rows.length) { box.innerHTML = '<div class="empty"><h3>Aún no tienes retos</h3><p>Crea uno arriba: fija el juego y la apuesta, y déjalo abierto o rétale a alguien por su usuario.</p></div>'; return; }
    box.innerHTML = '<div class="panel">' + rows.map(function (c) {
      var vs = c.opponent_id ? name(c.opponent_id === UID ? c.creator_id : c.opponent_id)
             : (c.target_id ? name(c.target_id) + " (invitado)" : "abierto");
      return '<div class="row row--reto"><div><div class="row__name">' + esc(c.game) + ' · ' + money(c.stake_cents) +
        '</div><div class="row__meta">' + esc(c.mode) + ' · vs ' + esc(vs) + ' · ' + statusLabel(c) + '</div></div>' +
        '<div class="row__act">' + retoActions(c) + '</div></div>';
    }).join("") + '</div>';
    wireRowActions(box);
  }
  function renderOpen(rows) {
    var box = $("reto-open");
    if (!rows.length) { box.innerHTML = '<div class="empty"><h3>No hay retos abiertos ahora</h3><p>Crea el tuyo y espera a que alguien lo acepte.</p></div>'; return; }
    box.innerHTML = '<div class="panel">' + rows.map(function (c) {
      return '<div class="row row--reto"><div><div class="row__name">' + esc(c.game) + ' · ' + money(c.stake_cents) +
        '</div><div class="row__meta">' + esc(c.mode) + ' · de ' + esc(name(c.creator_id)) + '</div></div>' +
        '<div class="row__act"><button type="button" class="btn btn--cta btn--sm" data-accept="' + esc(c.id) + '">Aceptar ' + money(c.stake_cents) + '</button></div></div>';
    }).join("") + '</div>';
    wireRowActions(box);
  }
  function retoActions(c) {
    var iAmCreator = c.creator_id === UID;
    var myReport = iAmCreator ? c.creator_report : c.opponent_report;
    if (c.status === "open" || c.status === "pending") {
      if (iAmCreator) return '<button type="button" class="btn btn--sm btn--danger" data-cancel="' + esc(c.id) + '">Cancelar</button>';
      if (c.target_id === UID) return '<button type="button" class="btn btn--cta btn--sm" data-accept="' + esc(c.id) + '">Aceptar ' + money(c.stake_cents) + '</button>';
      return '<span class="tag">pendiente</span>';
    }
    if (c.status === "active") {
      if (myReport) return '<span class="tag">esperando al rival</span>';
      return '<button type="button" class="btn btn--sm" data-won="' + esc(c.id) + '">Gané</button>' +
             '<button type="button" class="btn btn--sm" data-lost="' + esc(c.id) + '">Perdí</button>';
    }
    if (c.status === "settled") return c.winner_id === UID
      ? '<span class="tag" style="color:var(--c-good);border-color:rgba(53,208,127,.4)">ganaste</span>'
      : '<span class="tag revoked">perdiste</span>';
    if (c.status === "disputed") return '<span class="tag revoked">en disputa</span>';
    return '<span class="tag">' + statusLabel(c) + '</span>';
  }
  function wireRowActions(box) {
    box.querySelectorAll("[data-accept]").forEach(function (b) { b.addEventListener("click", function () { rpcReto("rib_challenge_accept", { p_challenge_id: b.getAttribute("data-accept") }, b); }); });
    box.querySelectorAll("[data-cancel]").forEach(function (b) { b.addEventListener("click", function () { rpcReto("rib_challenge_cancel", { p_challenge_id: b.getAttribute("data-cancel") }, b); }); });
    box.querySelectorAll("[data-won]").forEach(function (b) { b.addEventListener("click", function () { report(b.getAttribute("data-won"), UID, b); }); });
    box.querySelectorAll("[data-lost]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.getAttribute("data-lost");
        // el ganador es el otro; lo resolvemos leyendo el reto
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
      if (r.error) { msg($("reto-msg"), r.error.message || "No se pudo completar la acción.", false); if (btn) btn.disabled = false; return; }
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
      if (!game) { msg($("reto-msg"), "Indica el juego.", false); return; }
      if (!isFinite(stake)) { msg($("reto-msg"), "Elige la apuesta.", false); return; }
      var b = $("reto-save"); b.disabled = true;
      client.rpc("rib_challenge_create", { p_game: game, p_mode: mode, p_stake_cents: stake, p_target_username: target || null })
        .then(function (r) {
          if (r.error) { msg($("reto-msg"), r.error.message || "No se pudo crear el reto.", false); return; }
          show(form, false); $("reto-game").value = ""; $("reto-target").value = "";
          loadRetos(); refreshWallet();
        })
        .catch(function () { msg($("reto-msg"), "Error de red.", false); })
        .finally(function () { b.disabled = false; });
    });
  }

  /* ---- torneos ------------------------------------------------------------ */
  function loadTorneos() {
    client.from("tournaments").select("*").order("created_at", { ascending: false }).limit(50)
      .then(function (r) {
        var ts = (r.data) || [];
        if (r.error) { $("tor-list").innerHTML = '<p class="muted">No se pudieron cargar los torneos.</p>'; return; }
        if (!ts.length) { $("tor-list").innerHTML = '<div class="empty"><h3>No hay torneos todavía</h3><p>Crea el primero: pon la cuota y el cupo, y la bolsa se arma con las inscripciones.</p></div>'; return; }
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
      if (t.status === "open" && !mine) act = '<button type="button" class="btn btn--cta btn--sm" data-join="' + esc(t.id) + '">Entrar ' + (t.entry_fee_cents ? money(t.entry_fee_cents) : "gratis") + '</button>';
      else if (mine && t.status !== "finished") act = '<span class="tag" style="color:var(--c-good);border-color:rgba(53,208,127,.4)">inscrito</span>';
      if (iAmOrg && (t.status === "open" || t.status === "full" || t.status === "active") && es.length) {
        act += ' <select class="mini-sel" data-winsel="' + esc(t.id) + '"><option value="">Ganador…</option>' +
          es.map(function (e) { return '<option value="' + esc(e.user_id) + '">' + esc(name(e.user_id)) + '</option>'; }).join("") +
          '</select><button type="button" class="btn btn--sm" data-finish="' + esc(t.id) + '">Finalizar</button>';
      }
      if (t.status === "finished") act = '<span class="tag">ganó ' + esc(winner ? name(winner.user_id) : "—") + '</span>';
      return '<div class="tcard"><div class="tcard__top"><div><div class="tcard__name">' + esc(t.name) + '</div>' +
        '<div class="row__meta">' + esc(t.game) + ' · ' + statusTor(t.status) + '</div></div>' +
        '<div class="tcard__pool"><span class="k">bolsa</span><span class="v">' + money(t.prize_pool_cents) + '</span></div></div>' +
        '<div class="tcard__mid"><span>Cuota ' + (t.entry_fee_cents ? money(t.entry_fee_cents) : "gratis") + '</span>' +
        '<span>' + es.length + '/' + t.max_players + ' jugadores</span></div>' +
        '<div class="tcard__act">' + act + '</div></div>';
    }).join("");
    var box = $("tor-list");
    box.querySelectorAll("[data-join]").forEach(function (b) { b.addEventListener("click", function () { rpcTor("rib_tournament_join", { p_tournament_id: b.getAttribute("data-join") }, b); }); });
    box.querySelectorAll("[data-finish]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.getAttribute("data-finish");
        var sel = box.querySelector('[data-winsel="' + id + '"]');
        var w = sel ? sel.value : "";
        if (!w) { msgTor("Elige al ganador."); return; }
        rpcTor("rib_tournament_finish", { p_tournament_id: id, p_winner_id: w }, b);
      });
    });
  }
  function statusTor(s) { return { open: "Inscripciones abiertas", full: "Cupo lleno", active: "En curso", finished: "Finalizado", cancelled: "Cancelado" }[s] || s; }
  function msgTor(t) { msg($("tor-msg"), t, false); }
  function rpcTor(fn, args, btn) {
    if (btn) btn.disabled = true;
    client.rpc(fn, args).then(function (r) {
      if (r.error) { msgTor(r.error.message || "No se pudo completar la acción."); if (btn) btn.disabled = false; return; }
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
      if (!nm) { msgTor("Ponle nombre al torneo."); return; }
      if (!game) { msgTor("Indica el juego."); return; }
      if (!isFinite(fee)) fee = 0;
      var b = $("tor-save"); b.disabled = true;
      client.rpc("rib_tournament_create", { p_name: nm, p_game: game, p_entry_fee_cents: fee, p_max_players: max, p_starts_at: null })
        .then(function (r) {
          if (r.error) { msgTor(r.error.message || "No se pudo crear."); return; }
          show(form, false); $("tor-name").value = ""; $("tor-game").value = ""; loadTorneos();
        })
        .catch(function () { msgTor("Error de red."); })
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
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) { msg($("pf-msg"), "Usuario: 3–24 caracteres, letras, números o guion bajo.", false); return; }
      var btn = $("pf-save"); btn.disabled = true;
      client.from("profiles").update({ username: username, display_name: display || null }).eq("id", UID)
        .then(function (r) {
          if (r.error) {
            var m = (r.error.code === "23505") ? "Ese usuario ya está tomado." : (r.error.message || "No se pudo guardar.");
            msg($("pf-msg"), m, false); return;
          }
          msg($("pf-msg"), "Guardado.", true);
          handleCache[UID] = username;
          $("acct-name").textContent = "@" + username;
        })
        .catch(function () { msg($("pf-msg"), "Error de red. Intenta de nuevo.", false); })
        .finally(function () { btn.disabled = false; });
    });
  }

  /* ---- projects (real: projects table, RLS owner-only) -------------------- */
  function loadProjects() {
    client.from("projects").select("id, name, environment, created_at").order("created_at", { ascending: false })
      .then(function (r) {
        var list = $("proj-list");
        if (r.error) { list.innerHTML = '<p class="muted">No se pudieron cargar los proyectos.</p>'; return; }
        var rows = r.data || [];
        fillProjectSelect(rows);
        if (!rows.length) {
          list.innerHTML = '<div class="empty"><h3>Aún no tienes proyectos</h3><p>Crea uno para agrupar tus API keys por juego o entorno.</p></div>';
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
    sel.innerHTML = '<option value="">Sin proyecto</option>' + (rows || []).map(function (p) {
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
      if (nm.length < 1 || nm.length > 80) { msg($("proj-msg"), "Ponle un nombre (1–80 caracteres).", false); return; }
      var btn = $("proj-save"); btn.disabled = true;
      client.from("projects").insert({ owner_id: UID, name: nm, environment: env }).select().single()
        .then(function (r) {
          if (r.error) { msg($("proj-msg"), r.error.message || "No se pudo crear.", false); return; }
          show(form, false); $("proj-name").value = ""; $("proj-msg").hidden = true;
          loadProjects();
        })
        .catch(function () { msg($("proj-msg"), "Error de red. Intenta de nuevo.", false); })
        .finally(function () { btn.disabled = false; });
    });
  }

  /* ---- API keys ----------------------------------------------------------- */
  function loadKeys() {
    client.from("api_keys").select("id, name, environment, key_prefix, created_at, revoked_at").order("created_at", { ascending: false })
      .then(function (r) {
        var list = $("key-list");
        if (r.error) { list.innerHTML = '<p class="muted">No se pudieron cargar las keys.</p>'; return; }
        var rows = r.data || [];
        if (!rows.length) {
          list.innerHTML = '<div class="empty"><h3>Aún no tienes API keys</h3><p>Emite una para autenticar tu integración con el SDK. La verás completa una sola vez.</p></div>';
          return;
        }
        list.innerHTML = '<div class="panel">' + rows.map(function (k) {
          var revoked = !!k.revoked_at;
          return '<div class="row row--keys"><div><div class="row__name">' + esc(k.name || "default") +
            '</div><div class="row__meta"><code>' + esc(k.key_prefix) + '…</code> · ' + fmtDate(k.created_at) +
            '</div></div><span class="tag ' + (revoked ? "revoked" : (k.environment === "live" ? "live" : "")) + '">' +
            (revoked ? "revocada" : esc(k.environment)) + '</span>' +
            (revoked ? '' : '<button type="button" class="btn btn--sm btn--danger" data-revoke="' + esc(k.id) + '">Revocar</button>') +
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
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { $("key-copy").textContent = "Copiada"; }).catch(function () {});
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
          if (r.error || !r.data || !r.data.key) { msg($("key-msg"), "No se pudo emitir la key. Revisa que la función esté desplegada.", false); return; }
          $("key-msg").hidden = true;
          $("key-plaintext").textContent = r.data.key;
          $("key-copy").textContent = "Copiar";
          $("key-reveal").hidden = false;
          $("key-name").value = "";
          loadKeys();
        })
        .catch(function () { msg($("key-msg"), "Error de red. Intenta de nuevo.", false); })
        .finally(function () { btn.disabled = false; });
    });
  }

  /* ---- dev métricas (real, derivadas de tu cuenta) ------------------------ */
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
