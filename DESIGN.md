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
6. **Depth via gradient, never shadow.** No `box-shadow`; separation comes from
   surface steps, hairlines and internal multi-stop gradient blobs.

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
| Brand green | `#0ae448` → `#abff84` gradient |
| Matchmaking | `#00bae2` |
| Escrow | `#ff8709` |
| Settlement | `#fec5fb` |
| SDK / Text | `#9d95ff` |

Type scale: caption 14 · body-sm 16 · body 19 · body-lg 23 · subheading 34 ·
heading-sm 44 · heading 66 · heading-lg 101 · display 224 (all fluid via
`clamp()`).

## Structure

Static, dependency-free site (HTML + CSS + vanilla JS).

| File | Purpose |
|------|---------|
| `index.html` | Landing: hero, marquee, feature blocks, dev teaser, showcase, CTA |
| `how-it-works.html` | The trustless loop: steps, benefits, FAQ |
| `developers.html` | Quickstart, toolkit, waitlist form |
| `showcase.html` | Games grid, metrics, quote |
| `contact.html` | Contact channels + form |
| `404.html` | Not-found page |
| `styles.css` | Full design system + components |
| `app.js` | Nav, scroll reveal, page-transition curtain, FAQ, forms |
| `robots.txt`, `sitemap.xml`, `site.webmanifest` | SEO / PWA metadata |

## Interactions

- **Scroll reveal** via `IntersectionObserver` on `[data-reveal]` (staggered).
- **Page-transition curtain** on same-origin navigation (respects
  `prefers-reduced-motion`).
- **Sticky nav** that hides on scroll-down, reveals on scroll-up, and blurs once
  scrolled. Mobile slide-in menu.
- **FAQ accordion**, **animated blobs**, **infinite marquee**, gradient-hover
  buttons.
- All motion is disabled under `prefers-reduced-motion: reduce`.

## SEO

Every page ships a unique `<title>`, meta description, keywords, canonical URL,
Open Graph + Twitter Card tags, `theme-color`, and JSON-LD structured data
(`SoftwareApplication`, `HowTo`, `ContactPage`). Sitemap and robots included.
