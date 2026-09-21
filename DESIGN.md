# Runinback — Design System

A dark-canvas, typographic design language for **Runinback**, the trustless
skill-based wagering layer for competitive gaming. Inspired by the GSAP visual
system: a near-black stage, warm cream type, ghost-pill controls, oversized
display headlines, and a discipline-based color taxonomy.

## Principles

1. **One dark stage.** Everything sits on `#0e100f`. Panels lift one step to
   `#191919`. Cream (`#fffce1`) is the only light surface, used sparingly.
2. **Type is the hero.** A single humanist sans (Inter Tight, standing in for
   Mori) carries display headlines up to ~200px with tight negative tracking
   and near-1.0 line-height, and every body/label/nav item at 16–23px.
3. **Color is taxonomy, not decoration.** Each feature owns a hue:
   green = brand/core, blue = matchmaking, orange = escrow, pink = settlement,
   lilac = SDK/developers. Never reuse a hue for a different feature.
4. **Outlined-only controls.** Buttons are 100px-radius ghost pills with a 1px
   cream border. The single chromatic escalation is the green→light-green
   gradient-stroked primary CTA. No filled solid buttons.
5. **Signatures.** Every section opens with a `{ curly-bracket }` eyebrow.
   Feature blocks are divided by 1px `#42433d` hairlines.
6. **Angular brand geometry.** The identity is an ascending **peak / lightning
   mark** (see the logos). It appears as the nav/footer/favicon logo (an inline
   SVG that draws itself on load) and as the visual language for illustrations:
   crafted angular SVG art replaces organic blur-blobs, emoji icons and flat
   gradient placeholders. The landing hero is an exception: it runs a blurred,
   dark-scrimmed **looping background video** (see the hero row below) in place of
   the mountain mark and reactive grid, and the landing's feature blocks are
   text-only (no illustration panels).
7. **Depth via geometry, never shadow.** No decorative `box-shadow`; separation
   comes from surface steps, hairlines, a fine technical grid and a single
   restrained brand glow — no blurry blob soup.

## Tokens

Colors, typography scale, spacing, radius and surfaces are defined as CSS custom
properties at the top of `styles.css` under `:root`.

| Role | Value |
|------|-------|
| Canvas | `#0e100f` |
| Panel | `#191919` |
| Cream (text/surface) | `#fffce1` |
| Muted text | `#7c7c6f` |
| Hairline | `#42433d` |
| Brand accent (secondary) | `#ffffff` → `#fffce1` gradient (was green `#0ae448`) |
| Matchmaking | `#00bae2` |
| Escrow | `#ff8709` |
| Settlement | `#fec5fb` |
| SDK / Text | `#9d95ff` |

Type scale: caption 14 · body-sm 16 · body 19 · body-lg 23 · subheading 34 ·
heading-sm 44 · heading 66 · heading-lg 101 · display 224 (all fluid via
`clamp()`).

## Logo

The identity is the ascending **peak / lightning mark** — a four-point angular
peak with a detached spark stroke. It is drawn as **inline SVG** (never a raster
file), always in the brand accent — now white (`#ffffff`) on the dark canvas, with
`stroke-linecap: square` and `stroke-linejoin: miter` so every corner stays hard
and angular. The source artwork lives in the repo (`IMG_0133/0134/0135.PNG`) as
reference; the shipped site re-draws the mark in code for crispness at any size,
theming and the draw-on-load animation.

### Variant per context

| Context | Where | Composition | Rendered size |
|---------|-------|-------------|---------------|
| **Wordmark lockup** | Nav + footer, every page (`.brand` + `.brand__mark`) | Mark (viewBox `0 0 44 36`, peak stroke 5.2 + spark 4.2) followed by the "Runinback" wordmark in Inter Tight 20px | Mark `30 × 25px` |
| **Hero background video** | Landing hero only (`.hero__video` + `.hero__scrim`) | A looping background clip (`video_de_segundos_donde_rec.mp4`), blurred and darkened by a scrim so white type stays legible; JS plays only seconds 0–7 on loop, muted, and pauses under reduced motion | cover, full-bleed |
| **Favicon** | `<link rel="icon">`, all pages | Mark on a `#0e100f` rounded square (rx 7), green stroke, viewBox `0 0 32 32` | `32px` |
| **PWA / app icon** | `site.webmanifest` | Solid green rounded square (rx 128), no interior mark, for maskable app tiles | `512px` (`sizes: any`) |

### Minimum sizes

- **Wordmark lockup:** the mark holds at its `30 × 25px` default; do not render
  the mark-plus-wordmark below this. Below ~24px the wordmark stops being legible
  — use the mark alone (favicon variant) instead of shrinking the lockup.
- **Favicon:** `32px` is the floor; the square backing keeps the mark readable at
  tab size where a bare stroke would disappear.
- **Hero background video:** decorative only (`aria-hidden`); it carries no brand
  meaning, so no legibility floor applies.

### Clear space

- The lockup reserves a **10px gap** between the mark and the wordmark
  (`.brand { gap: 10px }`); keep this proportional if the lockup is scaled.
- Treat the mark's own bounding box as the minimum keep-clear margin on all
  sides — no other element crowds inside it.
- The favicon bakes its clear space into the rounded square; the mark is inset
  from the edges rather than bleeding to them.

### Behavior on mobile

- The **wordmark lockup stays fixed** at `30 × 25px` across every breakpoint and
  remains in the top bar even when the nav links collapse into the slide-in menu
  (`max-width: 640px`) — the logo is always the persistent anchor of the header.
- The **hero background video** covers the hero at every breakpoint, blurred and
  scrimmed; it is muted, `playsinline`, loops seconds 0–7, and pauses entirely
  under `prefers-reduced-motion`.
- All logo motion (the `mark-draw` stroke animation on load, the hover lift) and
  the hero grid's animation are **fully disabled under
  `prefers-reduced-motion: reduce`**; the grid renders as a static lattice.

## Structure

Static, dependency-free site (HTML + CSS + vanilla JS).

| File | Purpose |
|------|---------|
| `index.html` | Landing: video hero, story (what/why/how), feature blocks (text-only), dev teaser, CTA |
| `how-it-works.html` | The trustless loop: steps, benefits, FAQ |
| `developers.html` | Quickstart, toolkit, waitlist form |
| `contact.html` | Contact channels + form |
| `404.html` | Not-found page |
| `styles.css` | Full design system + components |
| `app.js` | Nav, scroll reveal, page-transition curtain, FAQ, forms |
| `robots.txt`, `sitemap.xml`, `site.webmanifest` | SEO / PWA metadata |

## Interactions

- **Scroll reveal** via `IntersectionObserver` on `[data-reveal]`, with
  directional/`zoom`/`clip` variants and staggering.
- **Section transitions** via `IntersectionObserver` on `[data-band]` (adds
  `.is-in`): a hairline wipes each band's top edge, headings clip-reveal
  (`[data-clip]`, padded so the tight display line-height never crops glyphs),
  content rises or slides in (`[data-rise]`, `="left"`/`="right"`) and feature
  bullets cascade. The landing uses the full set; `how-it-works`, `developers` and
  `contact` carry the band hairline over their existing `[data-reveal]` motion.
  All reveals share the decisive `--ease-in-out` curve. Across every page, `#main`
  body copy (muted greys included) reads in cream via
  `#main { --color-surface-50: var(--color-surface-cream) }`; nav and footer keep
  the muted taxonomy.
- **Hero video** loops seconds 0–7 of the background clip, muted and `playsinline`;
  paused under reduced motion.
- **Self-drawing SVG** — the brand mark, hero mark and feature illustrations
  animate their strokes (`stroke-dashoffset`) on load / on reveal.
- **Scroll progress bar** pinned to the top of the viewport.
- **Magnetic** CTA + brand mark and subtle **tilt/parallax** on illustration
  surfaces (pointer-fine devices only).
- **Page-transition curtain** on same-origin navigation.
- **Sticky nav** that hides on scroll-down, reveals on scroll-up, and blurs once
  scrolled. Mobile slide-in menu.
- **FAQ accordion**, smooth in-page anchor scrolling, and hover
  micro-interactions on cards, buttons and social icons.
- **Accessibility:** skip-to-content link, visible focus rings, `main` landmark.
  All motion is fully disabled under `prefers-reduced-motion: reduce`.

## SEO

Every page ships a unique `<title>`, meta description, keywords, canonical URL,
Open Graph + Twitter Card tags, `theme-color`, and JSON-LD structured data
(`SoftwareApplication`, `HowTo`, `ContactPage`). Sitemap and robots included.
