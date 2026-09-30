/* ==========================================================================
   Runinback — Quick Play prize table (landing).
   The static table ships the 4-player numbers; the bracket-size toggle swaps
   them for the chosen size using the same integer math the backend pays with
   (lib/tournament.js prizeSplit), counting each number to its new value.
   ========================================================================== */
import { prizeSplit } from "../lib/tournament.js";
import { countUp } from "./count-up.js";

const toRcoin = (cents) => String(parseFloat((cents / 100).toFixed(2)));

export function initPrizeTiers() {
  const table = document.querySelector("[data-tiers]");
  const toggle = document.querySelector("[data-size-toggle]");
  if (!table || !toggle) return;
  const label = table.querySelector("[data-size-label]");

  const apply = (size, animate) => {
    table.dataset.size = String(size);
    if (label) label.textContent = String(size);
    table.querySelectorAll("tr[data-fee]").forEach((row) => {
      const fee = Number(row.dataset.fee);
      if (!fee) return;
      const split = prizeSplit(fee, size);
      const values = { first: toRcoin(split.first), second: toRcoin(split.second), pool: toRcoin(split.pool) };
      row.querySelectorAll("[data-prize]").forEach((el) => {
        const next = values[el.dataset.prize];
        if (next == null) return;
        if (el.hasAttribute("data-count")) el.dataset.count = next;
        if (animate) countUp(el, next, { from: Number(el.textContent) || 0, duration: 550 });
        else el.textContent = next;
      });
    });
  };

  toggle.addEventListener("change", (e) => {
    const input = e.target.closest('input[type="radio"]');
    if (input && input.checked) apply(Number(input.value), true);
  });

  // A restored form state (back/forward cache) may start on 8 players.
  const checked = toggle.querySelector("input:checked");
  if (checked && checked.value !== "4") apply(Number(checked.value), false);
}
