/* ============================================================================
 * Runinback — minimal error reporting for the signed-in console.
 * Uncaught errors and unhandled promise rejections are sent to
 * rib_log_client_error (migration 0020): at most a few per page load, no
 * form data, and deduplicated by message. Never throws.
 * ========================================================================== */

const MAX_REPORTS_PER_PAGE = 5;

export function initTelemetry(getClient) {
  const seen = new Set();
  let sent = 0;

  function report(message, source, stack) {
    try {
      const text = String(message || "").slice(0, 500);
      if (!text || seen.has(text) || sent >= MAX_REPORTS_PER_PAGE) return;
      const client = getClient();
      if (!client) return;
      seen.add(text);
      sent += 1;
      client.rpc("rib_log_client_error", {
        p_message: text,
        p_source: source ? String(source).slice(0, 200) : null,
        p_url: location.pathname,
        p_stack: stack ? String(stack).slice(0, 4000) : null,
        p_user_agent: navigator.userAgent.slice(0, 300),
      }).then(function () {}, function () {});
    } catch (e) { /* reporting must never break the page */ }
  }

  window.addEventListener("error", function (e) {
    report(e.message, e.filename ? e.filename + ":" + e.lineno : null, e.error && e.error.stack);
  });
  window.addEventListener("unhandledrejection", function (e) {
    const reason = e.reason;
    report(reason && reason.message ? reason.message : String(reason), "unhandledrejection", reason && reason.stack);
  });
  return report;
}
