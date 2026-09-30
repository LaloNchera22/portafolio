/* ============================================================================
 * Runinback — in-page confirmation (native <dialog>: focus trap, Esc, inert
 * background). Replaces window.confirm/prompt, which webviews may block and
 * which can't be styled or labelled. Falls back to them where <dialog> is
 * missing.
 * ========================================================================== */
import { byId as $ } from "../lib/dom.js";

// Where focus goes when the dialog closes: the control that opened it, or,
// if a refresh redrew it meanwhile, its replacement (same id or data-* key).
function returnTarget(trigger) {
  if (!trigger || !trigger.focus) return null;
  if (trigger.isConnected) return trigger;
  if (trigger.id) return document.getElementById(trigger.id);
  const attr = Array.prototype.find.call(trigger.attributes || [], function (a) { return a.name.indexOf("data-") === 0 && a.value; });
  if (!attr || !window.CSS || !CSS.escape) return null;
  return document.querySelector("[" + attr.name + '="' + CSS.escape(attr.value) + '"]');
}

/**
 * @param {{title: string, body: string, ok: string, danger?: boolean, typeToConfirm?: string}} opts
 * @returns {Promise<boolean>} true only when confirmed (and, if asked, the
 *   exact text was typed)
 */
export function confirmAction(opts) {
  const dialog = $("confirm-dialog");
  const expected = opts.typeToConfirm || "";
  if (!dialog || typeof dialog.showModal !== "function") {
    if (expected) {
      const typed = window.prompt(opts.body + "\n\nType " + expected + " to confirm.");
      return Promise.resolve(typed !== null && typed.trim() === expected);
    }
    return Promise.resolve(window.confirm(opts.title + "\n\n" + opts.body));
  }

  if (dialog.open) return Promise.resolve(false);
  const trigger = document.activeElement;
  $("confirm-title").textContent = opts.title;
  $("confirm-body").textContent = opts.body;
  const ok = $("confirm-ok");
  ok.textContent = opts.ok;
  ok.className = "btn btn--sm " + (opts.danger ? "btn--danger" : "btn--cta");
  const field = $("confirm-type-field");
  const input = $("confirm-type");
  field.hidden = !expected;
  input.value = "";
  $("confirm-type-label").textContent = expected ? "Type " + expected + " to confirm" : "";
  const sync = function () { ok.disabled = !!expected && input.value.trim() !== expected; };
  input.oninput = sync;
  // Enter in the text box means "confirm" (the form's first button is Cancel).
  input.onkeydown = function (e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!ok.disabled) dialog.close("ok");
  };
  sync();

  return new Promise(function (resolve) {
    dialog.onclose = function () {
      dialog.onclose = null;
      input.oninput = null;
      input.onkeydown = null;
      const confirmed = dialog.returnValue === "ok" && (!expected || input.value.trim() === expected);
      const back = returnTarget(trigger);
      if (back) back.focus();
      resolve(confirmed);
    };
    dialog.returnValue = "";
    dialog.showModal();
    // Start on the safe choice (or the text box when typing is required).
    (expected ? input : $("confirm-cancel")).focus();
  });
}
