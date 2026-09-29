/* ============================================================================
 * Runinback — developer portal: projects, API keys, and account metrics.
 * API keys are minted by the issue-api-key Edge Function (only the hash is
 * stored); the plaintext is shown once.
 * ========================================================================== */
import { byId as $, escapeHtml as esc, setVisible, showMessage } from "../lib/dom.js";
import { formatDate } from "../lib/format.js";
import { functionError } from "../lib/errors.js";
import { config } from "../lib/config.js";
import { errorText, session } from "./context.js";

// Project names by id, for labelling keys.
const projectNames = {};

function environmentTag(env) {
  return env === "live" ? "live" : "";
}

/* ---- projects ------------------------------------------------------------ */
export function loadProjects() {
  session.client.from("projects").select("id, name, environment, created_at").order("created_at", { ascending: false })
    .then(function (r) {
      const list = $("project-list");
      if (r.error) { list.innerHTML = '<p class="muted">Couldn\'t load projects.</p>'; return; }
      const rows = r.data || [];
      fillProjectSelect(rows);
      if (!rows.length) {
        list.innerHTML = '<div class="empty"><h3>No projects yet</h3><p>Create one to group your API keys by game or environment.</p>' +
          '<p><button type="button" class="btn btn--cta btn--sm" data-empty-project>Create a project</button></p></div>';
        list.querySelector("[data-empty-project]").addEventListener("click", function () { $("project-new").click(); });
        return;
      }
      rows.forEach(function (p) { projectNames[p.id] = p.name; });
      list.innerHTML = '<div class="panel">' + rows.map(function (p) {
        return '<div class="row row--keys"><div><div class="row__name">' + esc(p.name) +
          '</div><div class="row__meta">' + esc(p.environment) + " · " + formatDate(p.created_at) +
          '</div></div><span class="tag ' + environmentTag(p.environment) + '">' + esc(p.environment) + "</span>" +
          '<button type="button" class="btn btn--sm btn--danger" data-project-delete="' + esc(p.id) + '" data-project-name="' + esc(p.name) + '">Delete</button></div>';
      }).join("") + "</div>";
      list.querySelectorAll("[data-project-delete]").forEach(function (b) {
        b.addEventListener("click", function () { deleteProject(b); });
      });
    });
}

// Deleting a project revokes its keys (database trigger), so say so first.
function deleteProject(btn) {
  const name = btn.getAttribute("data-project-name");
  if (!window.confirm("Delete project \u201c" + name + "\u201d? Its API keys are revoked immediately.")) return;
  btn.disabled = true;
  session.client.from("projects").delete().eq("id", btn.getAttribute("data-project-delete"))
    .then(function (r) {
      if (r.error) { btn.disabled = false; showMessage($("project-msg"), errorText(r.error, "Couldn't delete the project."), false); return; }
      loadProjects();
      loadKeys();
      loadDeveloperMetrics();
    })
    .catch(function () { btn.disabled = false; showMessage($("project-msg"), "Network error. Try again.", false); });
}

function curlExample(key) {
  return "curl " + config.supabaseUrl.replace(/\/+$/, "") + "/functions/v1/api/v1/status \\\n  -H \"Authorization: Bearer " + key + "\"";
}

function fillProjectSelect(rows) {
  const select = $("key-project");
  if (!select) return;
  select.innerHTML = '<option value="">No project</option>' + (rows || []).map(function (p) {
    return '<option value="' + esc(p.id) + '">' + esc(p.name) + " (" + esc(p.environment) + ")</option>";
  }).join("");
}

function initProjects() {
  const form = $("project-form");
  $("project-new").addEventListener("click", function () { setVisible(form, true); $("project-name").focus(); });
  $("project-cancel").addEventListener("click", function () { setVisible(form, false); $("project-msg").hidden = true; });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const name = ($("project-name").value || "").trim();
    const env = $("project-env").value === "live" ? "live" : "test";
    if (name.length < 1 || name.length > 80) { showMessage($("project-msg"), "Give it a name (1–80 characters).", false); return; }
    const btn = $("project-save");
    btn.disabled = true;
    session.client.from("projects").insert({ owner_id: session.uid, name: name, environment: env }).select().single()
      .then(function (r) {
        if (r.error) { showMessage($("project-msg"), errorText(r.error, "Couldn't create."), false); return; }
        setVisible(form, false);
        $("project-name").value = "";
        $("project-msg").hidden = true;
        loadProjects();
        loadDeveloperMetrics();
      })
      .catch(function () { showMessage($("project-msg"), "Network error. Try again.", false); })
      .finally(function () { btn.disabled = false; });
  });
}

/* ---- API keys ------------------------------------------------------------ */
export function loadKeys() {
  session.client.from("api_keys").select("id, name, environment, key_prefix, created_at, revoked_at, project_id, last_used_at").order("created_at", { ascending: false })
    .then(function (r) {
      const list = $("key-list");
      if (r.error) { list.innerHTML = '<p class="muted">Couldn\'t load keys.</p>'; return; }
      const rows = r.data || [];
      if (!rows.length) {
        list.innerHTML = '<div class="empty"><h3>No API keys yet</h3><p>Issue a test key to call the API from your server. You\'ll see it in full once.</p></div>';
        return;
      }
      list.innerHTML = '<div class="panel">' + rows.map(function (k) {
        const revoked = !!k.revoked_at;
        return '<div class="row row--keys"><div><div class="row__name">' + esc(k.name || "default") +
          '</div><div class="row__meta"><code>' + esc(k.key_prefix) + "…</code> · " +
          (k.project_id && projectNames[k.project_id] ? esc(projectNames[k.project_id]) + " · " : "") +
          "created " + formatDate(k.created_at) + " · " + (k.last_used_at ? "last used " + formatDate(k.last_used_at) : "never used") +
          '</div></div><span class="tag ' + (revoked ? "revoked" : environmentTag(k.environment)) + '">' +
          (revoked ? "revoked" : esc(k.environment)) + "</span>" +
          (revoked ? "" : '<button type="button" class="btn btn--sm btn--danger" data-revoke="' + esc(k.id) + '">Revoke</button>') +
          "</div>";
      }).join("") + "</div>";
      list.querySelectorAll("[data-revoke]").forEach(function (b) {
        b.addEventListener("click", function () { revokeKey(b.getAttribute("data-revoke"), b); });
      });
    });
}

function revokeKey(id, btn) {
  if (!window.confirm("Revoke this key? Apps using it stop working immediately. This can't be undone.")) return;
  btn.disabled = true;
  session.client.from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", id)
    .then(function (r) {
      if (r.error) { btn.disabled = false; showMessage($("key-msg"), errorText(r.error, "Couldn't revoke the key."), false); return; }
      loadKeys();
      loadDeveloperMetrics();
    })
    .catch(function () { btn.disabled = false; showMessage($("key-msg"), "Network error. Try again.", false); });
}

function initKeys() {
  const form = $("key-form");
  $("key-new").addEventListener("click", function () { setVisible(form, true); $("key-reveal").hidden = true; $("key-name").focus(); });
  $("key-cancel").addEventListener("click", function () {
    setVisible(form, false);
    $("key-msg").hidden = true;
    $("key-reveal").hidden = true;
    $("key-plaintext").textContent = ""; // don't leave a secret in the DOM
    $("key-curl").textContent = "";
  });
  $("key-copy").addEventListener("click", function () {
    const text = $("key-plaintext").textContent || "";
    if (!navigator.clipboard) { $("key-copy").textContent = "Select and copy"; return; }
    navigator.clipboard.writeText(text)
      .then(function () { $("key-copy").textContent = "Copied"; })
      .catch(function () { $("key-copy").textContent = "Copy failed: select it manually"; });
  });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const name = ($("key-name").value || "").trim() || "default";
    const env = $("key-env").value === "live" ? "live" : "test";
    const project = $("key-project").value || null;
    const btn = $("key-save");
    btn.disabled = true;
    $("key-reveal").hidden = true;
    session.client.functions.invoke("issue-api-key", { body: { name: name, environment: env, project_id: project } })
      .then(function (r) {
        if (r.error || !r.data || !r.data.key) {
          return functionError(r.error).then(function (err) { showMessage($("key-msg"), errorText(err, "Couldn't issue the key. Please try again."), false); });
        }
        $("key-msg").hidden = true;
        $("key-plaintext").textContent = r.data.key;
        $("key-curl").textContent = curlExample(r.data.key);
        $("key-copy").textContent = "Copy";
        $("key-reveal").hidden = false;
        $("key-name").value = "";
        loadKeys();
        loadDeveloperMetrics();
      })
      .catch(function () { showMessage($("key-msg"), "Network error. Try again.", false); })
      .finally(function () { btn.disabled = false; });
  });
}

/* ---- metrics (real, derived from your account) --------------------------- */
export function loadDeveloperMetrics() {
  session.client.from("projects").select("id", { count: "exact", head: true }).then(function (r) {
    $("metric-projects").textContent = r.error ? "—" : String(r.count || 0);
  });
  session.client.from("api_keys").select("revoked_at").then(function (r) {
    if (r.error) { $("metric-keys-total").textContent = "—"; $("metric-keys-active").textContent = "—"; return; }
    const rows = r.data || [];
    $("metric-keys-total").textContent = String(rows.length);
    $("metric-keys-active").textContent = String(rows.filter(function (k) { return !k.revoked_at; }).length);
  });
}

export function initDeveloperPortal() {
  initProjects();
  initKeys();
}
