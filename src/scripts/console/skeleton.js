/* ============================================================================
 * Runinback — skeleton placeholders: the shape of what's loading, so the page
 * doesn't jump when it lands. Hidden from assistive tech (the container's
 * aria-busy says it's loading); the shimmer is CSS and off under reduced motion.
 * ========================================================================== */

/** Rows of a list (ledger, my tournaments, ranking). */
export function skelRows(n) {
  let html = '<div class="skel skel--rows" aria-hidden="true">';
  for (let i = 0; i < (n || 3); i++) html += '<span class="skel__l"></span>';
  return html + "</div>";
}

/** Tournament cards (custom lobby). */
export function skelCards(n) {
  let html = '<div class="tgrid" aria-hidden="true">';
  for (let i = 0; i < (n || 3); i++) {
    html += '<div class="skel skel--card"><span class="skel__l" style="width:55%"></span><span class="skel__l" style="width:35%"></span>' +
      '<span class="skel__l skel__l--bar"></span><span class="skel__l skel__l--pill"></span></div>';
  }
  return html + "</div>";
}
