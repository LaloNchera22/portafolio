/* ============================================================================
 * Runinback — the brand's peak mark, drawn in, for empty states.
 * tone: "match" (Play), "settle" (results), "escrow" (wallet).
 * ========================================================================== */
export function peakArt(tone) {
  return '<svg class="empty__art empty__art--' + tone + '" viewBox="0 0 72 40" aria-hidden="true">' +
    '<path class="empty__peak" pathLength="1" d="M2 38 L22 12 L32 24 L46 4 L70 38"/>' +
    '<path class="empty__spark" pathLength="1" d="M54 2 L50 10 L56 10 L52 18"/></svg>';
}
