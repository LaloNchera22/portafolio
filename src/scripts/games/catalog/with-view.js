/* Compose a shared, DOM-free rules module with its client-side presentation
 * (view and any view-only helpers). Rules stay the single source of truth for
 * both the browser and the game-move Edge Function. */
export function withView(rules, presentation) {
  return Object.assign({}, rules, presentation);
}
