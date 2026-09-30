/* ============================================================================
 * Runinback — one polite live region for status the console narrates
 * (a room changing state, a clock about to run out, seats filling).
 * Throttled: announcements closer than MIN_GAP_MS apart collapse into the
 * latest one, so a burst of updates is read once, never as a stream.
 * ========================================================================== */
const MIN_GAP_MS = 2500;
let region = null;
let lastAt = -Infinity;
let pending = "";
let timer = 0;
let flip = false;

function node() {
  if (region && region.isConnected) return region;
  region = document.getElementById("capp-announce");
  if (!region) {
    region = document.createElement("p");
    region.id = "capp-announce";
    region.className = "visually-hidden";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    (document.querySelector(".capp") || document.body).appendChild(region);
  }
  return region;
}

function flush() {
  timer = 0;
  if (!pending) return;
  lastAt = Date.now();
  // A trailing no-break space that alternates makes a repeated sentence a
  // real change, so screen readers read it again.
  flip = !flip;
  node().textContent = pending + (flip ? " " : "");
  pending = "";
}

/** Queue a polite announcement; the newest text wins within the gap. */
export function announce(text) {
  if (!text || typeof document === "undefined") return;
  pending = String(text);
  if (timer) return;
  const wait = Math.max(0, lastAt + MIN_GAP_MS - Date.now());
  if (!wait) flush();
  else timer = setTimeout(flush, wait);
}
