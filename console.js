/* ============================================================================
 * Runinback — console (dashboard) logic.
 * Convenience gate + real data. The client-side redirect is UX only; the true
 * authorization boundary is Row Level Security in Postgres: every query below
 * can only touch rows owned by the signed-in user, and API keys are minted only
 * by the issue-api-key Edge Function (service role, server-side).
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

  A.getSession().then(function (session) {
    if (!session) { toLanding(); return; }
    UID = session.user.id;
    show(loading, false);
    show(app, true);

    var u = session.user || {};
    var meta = u.user_metadata || {};
    $("acct-name").textContent = meta.username ? "@" + meta.username : (u.email || "");
    $("acct-email").textContent = u.email || "";

    wireNav();
    wirePersona();
    wireProfile();
    wireProjects();
    wireKeys();

    loadProfile();
    loadProjects();
    loadKeys();
  }).catch(function () { toLanding(); });

  /* ---- navigation --------------------------------------------------------- */
  function wireNav() {
    document.querySelectorAll(".capp__menu a[data-page]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        gotoPage(a.getAttribute("data-page"), a);
      });
    });
  }
  function gotoPage(id, link) {
    document.querySelectorAll(".capp .page").forEach(function (p) { p.hidden = p.id !== id; });
    var nav = link ? link.parentNode : null;
    if (nav) nav.querySelectorAll("a").forEach(function (a) {
      if (a.getAttribute("data-page") === id) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }
  function wirePersona() {
    var navPlayer = $("nav-player"), navDev = $("nav-dev");
    document.querySelectorAll(".persona button").forEach(function (b) {
      b.addEventListener("click", function () {
        var dev = b.getAttribute("data-persona") === "dev";
        $("tab-player").setAttribute("aria-selected", String(!dev));
        $("tab-dev").setAttribute("aria-selected", String(dev));
        show(navPlayer, !dev);
        show(navDev, dev);
        var first = (dev ? navDev : navPlayer).querySelector("a[data-page]");
        if (first) gotoPage(first.getAttribute("data-page"), first);
      });
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
        if (p.username) $("acct-name").textContent = "@" + p.username;
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
      var name = ($("proj-name").value || "").trim();
      var env = $("proj-env").value === "live" ? "live" : "test";
      if (name.length < 1 || name.length > 80) { msg($("proj-msg"), "Ponle un nombre (1–80 caracteres).", false); return; }
      var btn = $("proj-save"); btn.disabled = true;
      client.from("projects").insert({ owner_id: UID, name: name, environment: env }).select().single()
        .then(function (r) {
          if (r.error) { msg($("proj-msg"), r.error.message || "No se pudo crear.", false); return; }
          show(form, false); $("proj-name").value = ""; $("proj-msg").hidden = true;
          loadProjects();
        })
        .catch(function () { msg($("proj-msg"), "Error de red. Intenta de nuevo.", false); })
        .finally(function () { btn.disabled = false; });
    });
  }

  /* ---- API keys (real: list + revoke via RLS, issue via Edge Function) ----- */
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
      .then(function (r) { loadKeys(); })
      .catch(function () { btn.disabled = false; });
  }
  function wireKeys() {
    var form = $("key-form");
    $("key-new").addEventListener("click", function () { show(form, true); $("key-reveal").hidden = true; $("key-name").focus(); });
    $("key-cancel").addEventListener("click", function () { show(form, false); $("key-msg").hidden = true; $("key-reveal").hidden = true; });
    $("key-copy").addEventListener("click", function () {
      var txt = $("key-plaintext").textContent || "";
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { $("key-copy").textContent = "Copiada"; });
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var name = ($("key-name").value || "").trim() || "default";
      var env = $("key-env").value === "live" ? "live" : "test";
      var project = $("key-project").value || null;
      var btn = $("key-save"); btn.disabled = true;
      $("key-reveal").hidden = true;
      client.functions.invoke("issue-api-key", { body: { name: name, environment: env, project_id: project } })
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
})();
