<!-- PatchDeck — Marketing website implementation plan -->
<!-- Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net> -->

# PatchDeck Marketing Website — Implementation Plan

**Status:** awaiting approval
**Branch:** `jeremymcs/website`
**Date:** 2026-08-30

## Decisions (confirmed with owner)

| Decision | Choice |
| --- | --- |
| Location / deploy | New top-level `site/` directory, its own Vercel project |
| Stack | Static HTML + Tailwind CLI (no framework, no runtime JS deps) |
| Positioning | Pure free OSS — install CTA + GitHub stars, no pricing, no email capture |
| Scope | One long landing page; everything else deep-links to existing docs |

Existing GitHub Pages docs (`docs/`, `.github/workflows/pages.yml`) are **left untouched**.
The new site links out to them.

## 1. Directory layout

```text
site/
  package.json           # standalone; only devDep is tailwindcss
  package-lock.json
  tailwind.config.cjs    # brand tokens
  vercel.json            # cache headers + clean URLs
  build.mjs              # tailwind CLI + copy index.html/public -> dist
  index.html             # the entire landing page (source of truth)
  src/
    input.css            # @tailwind directives + component layer
  public/
    assets/*.webp        # pre-optimized screenshots (committed)
    favicon.svg
    og.png
    robots.txt
    sitemap.xml
  dist/                  # build output (gitignored) -> Vercel output dir
  README.md              # how to run/deploy the site
```

Root `.gitignore` gains `site/dist/`.

## 2. Build

- `site/package.json` is standalone so Vercel's **Root Directory = `site`** works
  cleanly and the marketing site never pulls the app's ~120 dependencies.
- `npm run build` = `node build.mjs`, which:
  1. runs `tailwindcss -c tailwind.config.cjs -i src/input.css -o dist/styles.css --minify`
  2. copies `index.html` -> `dist/index.html`
  3. copies `public/**` -> `dist/`
- `npm run dev` = same with `--watch`.
- No PostCSS config needed; Tailwind CLI handles it.

**Vercel project settings** (documented in `site/README.md`, applied via dashboard):
Root Directory `site` · Framework Preset `Other` · Build `npm run build` · Output `dist`.

## 3. Image optimization (done once, committed — not at build time)

Screenshots in `docs/assets/` total ~4 MB. Keeping the build reproducible on
Vercel's Linux builders means pre-optimizing locally with `sips` and committing
the results, rather than shelling out to macOS tools during CI.

| Source | Target |
| --- | --- |
| `PatchDeck-Dashboard.png` (3840w, 244 KB) | 1920w webp |
| `PatchDeck-PRs.png` (997 KB) | 1920w webp |
| `PatchDeck-Issues.png` (886 KB) | 1920w webp |
| `PatchDeck-Releases.png` (348 KB) | 1920w webp |
| `PatchDeck-Settings.png` (315 KB) | 1920w webp |
| `PatchDeck-Logs.png` (1.2 MB) | 1920w webp |

`hero-background.png` (1.5 MB) is **not** copied — it is a plain dark-blue radial
gradient, reproduced in CSS at zero bytes.

Every `<img>` gets explicit `width`/`height` (no layout shift), `loading="lazy"`
+ `decoding="async"` below the fold, and a real descriptive `alt`.

## 4. Visual direction

Reconciles `design-system/patchdeck/MASTER.md` with how the product actually looks.

- **Surface:** near-black `#08090C`, panels `#111318`, hairline borders
  `rgba(148,163,184,.12)` — matches the real dashboard, not a generic slate theme.
- **Primary CTA:** green `#22C55E` (per MASTER.md "code dark + run green").
- **State accents:** blue `#60A5FA` (processing), amber `#F59E0B` (in progress),
  red `#EF4444` (failed), green `#22C55E` (resolved). These are the product's own
  status colors and give the page a distinctive, honest palette.
- **Type:** Fira Code for headings/micro-labels, Fira Sans for body (per MASTER.md,
  via Google Fonts with full system fallback stacks).
- **Signature detail:** uppercase wide-tracked micro-labels and tabular numerals,
  lifted straight from the dashboard chrome.

> Deviation to flag: MASTER.md specifies green as the sole accent. The product UI is
> blue/amber/red. Plan keeps green for CTAs only and uses the product's real state
> colors elsewhere, so the site looks like the app it is selling.

## 5. Page sections

1. **Nav** — sticky, hairline bottom border. Logo, Features / How it works / Docs /
   GitHub, `npm i -g` CTA. Mobile: details/summary disclosure, no JS framework.
2. **Hero** — headline, subhead, copy-to-clipboard install command, secondary
   "View on GitHub". Badge row: MIT · Node 22+ · v1.6.0 · local-first.
   Dashboard screenshot in a window frame over a CSS radial glow.
3. **The problem** — the stale-PR loop, three beats. Uses `sdlc-bottleneck.png`.
4. **How it works** — Watch → Sync → Triage → Dispatch, plus the real feedback
   lifecycle (`pending → queued → in_progress → resolved`, branching to
   `rejected` / `flagged` / `failed`) drawn as inline SVG, theme-aware.
5. **Feature sections** — alternating layout, each with a real screenshot:
   Pull requests · Issues · Releases · CI & deployment healing · Logs · Settings.
6. **Local-first & safe by default** — the genuine differentiator, straight from
   the README: state lives in `~/.patchdeck/state.sqlite`, git work happens in
   app-owned worktrees, auto releases / CI healing / deployment healing all off by
   default, drain mode, hourly agent-run ceiling, token redaction in logs,
   remote access opt-in.
7. **Interfaces** — 4 cards: web dashboard, MCP server, local REST API, desktop app.
8. **Install / quickstart** — prerequisites (Node 22+, Git, GitHub auth, `claude`
   or `codex`), install command, first-run cautious-defaults checklist.
9. **FAQ** — native `<details>`: what it costs, which agents, where data lives,
   does it need repo write access, can I run it remotely, does it work on Windows.
10. **Footer** — MIT, © 2026, fork credit to `yungookim/oh-my-pr`, doc/repo links.

## 6. Quality bar

- Semantic landmarks, one `<h1>`, skip-to-content link.
- Visible `:focus-visible` rings on every interactive element.
- `prefers-reduced-motion` honored; all motion is CSS-only.
- Responsive from 320px; no horizontal body scroll (wide blocks scroll internally).
- Meta: description, canonical, OG + Twitter card, `theme-color`,
  JSON-LD `SoftwareApplication`, `robots.txt`, `sitemap.xml`.
- Total JS: one small inline script for copy-to-clipboard and the mobile nav.
  No frameworks, no analytics, no third-party requests except Google Fonts.

## 7. Copy accuracy rules

Every claim traces to the repo. No invented metrics, no fake testimonials, no
made-up user counts, no "10x faster". Version and feature claims come from
`README.md` and `package.json` (v1.6.0). The README's own caution — *"PatchDeck can
spend paid agent usage when automation is enabled"* — is surfaced on the page
rather than hidden, because it builds trust with the exact audience being targeted.

## 8. Build order

1. Scaffold `site/` + standalone `package.json`, install `tailwindcss`.
2. Optimize + commit screenshots into `site/public/assets/`.
3. `tailwind.config.cjs` + `src/input.css` brand tokens.
4. Write `index.html` section by section.
5. `build.mjs`, `vercel.json`, `robots.txt`, `sitemap.xml`, favicon, OG image.
6. Build, then verify the rendered page in a browser at desktop + mobile widths.
7. `site/README.md` with Vercel setup steps.
8. Commit on `jeremymcs/website`.

## 9. Out of scope

- Creating/linking the Vercel project or buying a domain (owner action; can be
  driven via the Vercel connector on request).
- Restyling the existing `docs/` site.
- Blog, changelog page, or any additional marketing pages.
