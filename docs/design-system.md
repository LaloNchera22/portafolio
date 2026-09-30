# Runinback — Design System

A dark-canvas, typographic design language for **Runinback**, the trustless
skill-based competition platform for video games. Inspired by the GSAP visual
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
   gradient placeholders. The landing hero and the auth split panel carry the
   **stage backdrop** (see the row below): the technical grid, the one glow and
   a faint angular ridge in the mark's language. The site ships no raster or
   video backgrounds, and never game art or third-party IP. The landing's
   feature blocks are text-only (no illustration panels).
7. **Depth via geometry, never shadow.** No decorative `box-shadow`; separation
   comes from surface steps, hairlines, a fine technical grid and a single
   restrained brand glow — no blurry blob soup.

## Tokens

Colors, typography scale, spacing, radius and surfaces are defined as CSS custom
properties at the top of `src/styles/site.css` under `:root`.

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
and angular. The source artwork lives in the repo (`docs/images/reference-0133/0134/0135.png`) as
reference; the shipped site re-draws the mark in code for crispness at any size,
theming and the draw-on-load animation.

### Variant per context

| Context | Where | Composition | Rendered size |
|---------|-------|-------------|---------------|
| **Wordmark lockup** | Nav + footer, every page (`.brand` + `.brand__mark`) | Mark (viewBox `0 0 44 36`, peak stroke 5.2 + spark 4.2) followed by the "Runinback" wordmark in Inter Tight 20px | Mark `30 × 25px` |
| **Stage backdrop** | Landing hero + login/signup split panel (`.backdrop.backdrop--stage`, inline, `aria-hidden`) | The fine technical grid tilted in perspective (`rotateX(28deg)`) drifting one cell every 16s; the single brand glow (`.backdrop::after`); an inline-SVG ridge of two angular peak lines with survey ticks and a detached spark (the mark's language) that draws in once, then the spark and ticks breathe in opacity. Low contrast (cream at 7–22% alpha); in the hero it fades toward the copy side and the band edge. Pure CSS + SVG, no requests; continuous motion is transform/opacity only | full-bleed; ridge `max(100%, 760px)` wide, right-anchored |
| **Favicon** | `<link rel="icon">`, all pages | Mark on a `#0e100f` rounded square (rx 7), green stroke, viewBox `0 0 32 32` | `32px` |
| **PWA / app icon** | `site.webmanifest` | Solid green rounded square (rx 128), no interior mark, for maskable app tiles | `512px` (`sizes: any`) |

### Minimum sizes

- **Wordmark lockup:** the mark holds at its `30 × 25px` default; do not render
  the mark-plus-wordmark below this. Below ~24px the wordmark stops being legible
  — use the mark alone (favicon variant) instead of shrinking the lockup.
- **Favicon:** `32px` is the floor; the square backing keeps the mark readable at
  tab size where a bare stroke would disappear.
- **Stage backdrop:** decorative only (`aria-hidden`), so no legibility floor
  applies; it must stay low-contrast so the headline and the bracket lead.

### Clear space

- The lockup reserves a **10px gap** between the mark and the wordmark
  (`.brand { gap: 10px }`); keep this proportional if the lockup is scaled.
- Treat the mark's own bounding box as the minimum keep-clear margin on all
  sides — no other element crowds inside it.
- The favicon bakes its clear space into the rounded square; the mark is inset
  from the edges rather than bleeding to them.

### Behavior on mobile

- The **mark stays fixed** across every breakpoint as the persistent anchor of
  the header (the wordmark hides below 460px). The header holds only the logo
  and the account actions (Log in + Sign up), so there is no collapsed menu at
  any width; both actions fit next to the mark at 320px.
- The **stage backdrop** covers the hero at every breakpoint (320px → wide);
  below 760px the ridge keeps its size and crops from the left, so the summit
  and spark stay in view. Under `prefers-reduced-motion` it is fully static:
  the grid holds still, the ridge renders fully drawn and nothing pulses.
- All logo motion (the `mark-draw` stroke animation on load, the hover lift) and
  the hero grid's animation are **fully disabled under
  `prefers-reduced-motion: reduce`**; the grid renders as a static lattice.

## Structure

Static, dependency-free site (HTML + CSS + vanilla JS).

| File | Purpose |
|------|---------|
| `src/index.html` | Landing: hero (stage backdrop + bracket) + stats, highlights strip, two ways in (Play / Host), prize calculator (`#prizes`), how it works timeline (`#how`), fair play (`#fair`), FAQ (`#faq`), CTA |
| `src/contact.html` | Contact channels + form |
| `src/login.html`, `src/signup.html` | Auth pages |
| `src/terms.html`, `src/privacy.html`, `src/cookies.html` | Legal pages |
| `src/404.html` | Not-found page |
| `src/styles/site.css` | Full design system + components (landing pieces under the `lx-` prefix) |
| `src/scripts/site/interactions.js` | Nav chrome, scroll reveal, FAQ, forms, magnetic CTAs, cookie notice |
| `src/scripts/site/landing.js` | Landing only: prize calculator, card spotlight, timeline progress |
| `vercel.json` | Headers + permanent redirects (`/how-it-works(.html)` → `/#how`; the old page was folded into the landing) |
| `public/robots.txt`, `public/sitemap.xml`, `public/site.webmanifest` | SEO / PWA metadata |

## Interactions

- **Scroll reveal** via `IntersectionObserver` on `[data-reveal]`, with
  directional/`zoom`/`clip` variants and staggering.
- **Section transitions (landing)** via `IntersectionObserver` on `[data-band]`
  (adds `.is-in`): a hairline wipes each band's top edge, headings clip-reveal
  (`[data-clip]`), content rises or slides in (`[data-rise]`, `="left"`/`="right"`)
  and feature bullets cascade — all on the decisive `--ease-in-out` curve. On the
  landing, body copy (including muted greys) reads in cream via
  `body.home #main { --color-surface-50: var(--color-surface-cream) }`.
- **Stage backdrop** (hero + auth panel): CSS-only grid drift and a one-off ridge
  draw, then a slow opacity pulse on the spark; static under reduced motion.
- **Self-drawing SVG** — the brand mark, hero mark and feature illustrations
  animate their strokes (`stroke-dashoffset`) on load / on reveal.
- **Scroll progress bar** pinned to the top of the viewport.
- **Magnetic** CTA + brand mark and subtle **tilt/parallax** on illustration
  surfaces (pointer-fine devices only).
- **Page-transition curtain** on same-origin navigation.
- **Sticky nav** that hides on scroll-down, reveals on scroll-up, and blurs once
  scrolled. It carries only the logo and the account slot (`<nav class="nav__actions"
  aria-label="Account">` wrapping `#nav-account`): Log in + Sign up, swapped for
  Console + Log out by `auth/account-nav.js` when signed in. No link list, no
  menu toggle; every other destination lives in the footer.
- **Landing (`lx-*`)**:
  - *Headline* rises word by word on load (`.lx-word`, staggered by `--i`); the
    last sentence carries the brand gradient as text. This is the page's one
    orchestrated entrance, done in CSS so the LCP paints on the first frame.
  - *Stats* under the hero (`.lx-stats`): three facts on hairlines; numbers count up.
  - *Highlights* (`.lx-strip`): a static, full-bleed hairline-bordered strip of
    product facts, each phrase once, as a centered wrapping list
    (`<ul aria-label="Highlights">`) with a small peak glyph leading each item.
    No marquee; items fade in once, staggered, on reveal (none under reduced
    motion).
  - *Two ways in* (`.lx-path`): Play is blue (matchmaking), Host is orange
    (escrow / commission). Cards with `[data-spotlight]` get a pointer-tracked
    radial glow on the surface and the 1px border (`--mx/--my`, fine pointers
    only, one rAF per frame) — never a box-shadow.
  - *Prize calculator* (`.lx-calc`): entry fee slider (1–50 rcoin) × players
    (4/8/16/32) through `hostedSplit` from `lib/hosted.js`, the same math the
    payout job uses. Numbers count to their new value; the split bar grows in on
    reveal. Champion = pink (settlement), host = orange, Runinback = muted grey.
  - *Timeline* (`.lx-steps`): a rail that fills with scroll (`--progress`, set by
    one passive rAF-throttled scroll listener that only runs while an
    IntersectionObserver says the section is near) and highlights the step
    under the reading line; the heading column is sticky on desktop.
  - *Fair play* (`.lx-fair`): four rule cards with the same spotlight.
  - *CTA* (`.lx-cta`): a hairline border with a soft light running around it
    (conic gradient on a registered `--lx-angle`).
- **FAQ accordion**, smooth in-page anchor scrolling, and hover
  micro-interactions on cards, buttons and social icons.
- **Accessibility:** skip-to-content link, visible focus rings, `main` landmark.
  All motion is fully disabled under `prefers-reduced-motion: reduce`.

## SEO

Every page ships a unique `<title>`, meta description, keywords, canonical URL,
Open Graph + Twitter Card tags, `theme-color`, and JSON-LD structured data
(`SoftwareApplication`, `HowTo`, `ContactPage`). Sitemap and robots included.
