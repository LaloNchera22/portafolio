/* ============================================================================
 * Runinback — one bracket drawing for every surface (My tournaments, the
 * Hosting page, a hosted tournament's page, the ops queue). Rounds run left
 * to right with connectors and a champion slot; the player's own path is
 * marked. renderBracket() remembers the winners it last drew in a box, so a
 * decided match animates the winner advancing (and a new champion lands)
 * instead of the whole bracket blinking.
 * ========================================================================== */
import { escapeHtml as esc } from "../lib/dom.js";
import { formatRcoin } from "../lib/format.js";
import { replayClass } from "../lib/motion.js";
import { shapeBracket } from "../lib/hosted.js";

const drawn = new WeakMap(); // box -> { roomId: winner id } from the last render

function playerCell(m, uid, name, me) {
  if (!uid) return '<span class="bracket__p is-tbd">' + (m.walkover && m.status === "done" ? "Bye" : "TBD") + "</span>";
  const won = m.winner_id && m.winner_id === uid;
  const lost = m.winner_id && m.winner_id !== uid;
  return '<span class="bracket__p' + (won ? " is-win" : "") + (lost ? " is-out" : "") + (uid === me ? " is-me" : "") + '" data-uid="' + esc(uid) + '">@' + esc(name || "player") + "</span>";
}

function noteFor(m) {
  if (m.walkover) return '<span class="bracket__note">' + (m.player_a && m.player_b ? "walkover" : "bye") + "</span>";
  if (m.status === "void") return '<span class="bracket__note">no result</span>';
  if (m.status === "setup") return '<span class="bracket__note is-setup">waiting for the lobby</span>';
  if (m.status === "live") return '<span class="bracket__note is-live">playing</span>';
  return "";
}

/**
 * @param {Array} rows normalized bracket rows (lib/hosted.js normalizeBracket)
 * @param {{ size?: number, rounds?: number, uid?: string,
 *   champPrize?: (final: object|undefined) => number|null,
 *   action?: (match: object, mine: boolean) => string }} opts
 */
export function bracketHtml(rows, opts) {
  const o = opts || {};
  const me = o.uid || null;
  const shaped = shapeBracket(rows, { size: o.size, rounds: o.rounds });
  const rounds = shaped.length;
  const match = function (m) {
    const mine = !!me && (m.player_a === me || m.player_b === me);
    const act = o.action ? o.action(m, mine) : "";
    return '<div class="bracket__m' + (mine ? " is-mine" : "") + '" data-match="' + esc(m.room_id || "") + '">' +
      playerCell(m, m.player_a, m.a_username, me) + playerCell(m, m.player_b, m.b_username, me) + noteFor(m) +
      (act ? '<span class="bracket__act">' + act + "</span>" : "") + "</div>";
  };
  let html = '<div class="bracket__cols" tabindex="0" role="group" aria-label="Bracket">';
  shaped.forEach(function (col, i) {
    const pairs = [];
    for (let k = 0; k < col.matches.length; k += 2) pairs.push(col.matches.slice(k, k + 2));
    html += '<div class="bracket__col" style="--i:' + i + '"><h4>' + esc(col.label) + '</h4><div class="bracket__slots">' +
      pairs.map(function (p) {
        const mine = !!me && p.some(function (m) { return m.player_a === me || m.player_b === me; });
        return '<div class="bracket__pair' + (p.length > 1 ? " is-pair" : "") + (mine ? " has-me" : "") + '">' + p.map(match).join("") + "</div>";
      }).join("") + "</div></div>";
  });
  const final = shaped.length ? shaped[shaped.length - 1].matches[0] : undefined;
  const champ = final && final.status === "done" && final.winner_id
    ? (final.winner_id === final.player_a ? final.a_username : final.b_username) : null;
  const prize = o.champPrize ? o.champPrize(final) : null;
  html += '<div class="bracket__col bracket__col--champ" style="--i:' + rounds + '"><h4>Champion</h4><div class="bracket__slots"><div class="bracket__champ' + (champ ? " is-set" : "") + '">' +
    '<span class="' + (champ ? "v" : "muted") + '">' + (champ ? "@" + esc(champ) : "TBD") + "</span>" +
    (prize ? '<span class="k">' + formatRcoin(prize) + "</span>" : "") + "</div></div></div>";
  return html + "</div>";
}

/**
 * Draw a bracket into `box`. The first time it opens its rounds reveal left
 * to right; after that a match that got a winner since the last draw
 * highlights the winner and the next-round slot they moved into.
 */
export function renderBracket(box, rows, opts) {
  if (!box) return;
  const before = drawn.get(box);
  const scroll = box.querySelector(".bracket__cols");
  const left = scroll ? scroll.scrollLeft : 0;
  box.innerHTML = bracketHtml(rows, opts);
  box.classList.toggle("is-reveal", !before);
  const now = {};
  (rows || []).forEach(function (m) { if (m.room_id) now[m.room_id] = m.winner_id || null; });
  drawn.set(box, now);
  const cols = box.querySelector(".bracket__cols");
  if (cols && left) cols.scrollLeft = left;
  if (!before) return;
  (rows || []).forEach(function (m) {
    if (!m.room_id || !m.winner_id || before[m.room_id] === m.winner_id) return;
    const cell = box.querySelector('[data-match="' + String(m.room_id).replace(/"/g, "") + '"] [data-uid="' + String(m.winner_id).replace(/"/g, "") + '"]');
    if (cell) replayClass(cell, "is-advanced");
    // The same player in a later round: the slot they just moved into.
    box.querySelectorAll('[data-uid="' + String(m.winner_id).replace(/"/g, "") + '"]').forEach(function (el) {
      const host = el.closest("[data-match]");
      const row = host && (rows || []).find(function (x) { return x.room_id === host.getAttribute("data-match"); });
      if (row && row.round > m.round) replayClass(el, "is-arrived");
    });
  });
  // The final was just decided: the champion slot lands.
  const last = (rows || []).reduce(function (top, m) { return !top || m.round > top.round ? m : top; }, null);
  const champ = box.querySelector(".bracket__champ.is-set");
  if (champ && last && last.room_id && now[last.room_id] && before[last.room_id] !== now[last.room_id]) replayClass(champ, "is-crowned");
}
