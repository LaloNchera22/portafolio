/* ============================================================================
 * Runinback — small DOM helpers shared by every page.
 * ========================================================================== */

export function byId(id) {
  return document.getElementById(id);
}

export function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

export function setVisible(node, visible) {
  if (node) node.hidden = !visible;
}

/** Escape a value for safe interpolation into an HTML string. */
export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/** Show an inline status message (.msg) as success or error. */
export function showMessage(node, text, ok) {
  if (!node) return;
  // Errors interrupt, confirmations wait their turn; set before the text so
  // the live region exists when the content lands.
  node.setAttribute("role", ok ? "status" : "alert");
  node.textContent = text;
  node.className = "msg " + (ok ? "msg--ok" : "msg--err");
  node.hidden = false;
}
