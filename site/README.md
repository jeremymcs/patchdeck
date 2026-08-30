<!-- PatchDeck Website — build and deployment notes -->
<!-- Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net> -->

# PatchDeck marketing site

The public landing page for PatchDeck. A single static HTML page compiled with the
Tailwind CLI — no framework, no runtime dependencies, no build-time network calls.

This is **separate** from the documentation site in `../docs/`, which is still
deployed to GitHub Pages by `.github/workflows/pages.yml`. The landing page links
out to those docs.

## Layout

```text
site/
  index.html          the entire page — the source of truth for all copy
  src/input.css       base styles + component layer
  tailwind.config.cjs brand tokens (colors, fonts)
  build.mjs           Tailwind CLI + copy index.html and public/ into dist/
  public/             static assets copied verbatim to the site root
    assets/           pre-optimized screenshots (webp) and the OG image
  vercel.json         cache headers and security headers
  dist/               build output — gitignored
```

## Local development

```bash
cd site
npm install
npm run dev      # rebuilds dist/ on change
```

Then serve `dist/` with any static server, e.g.:

```bash
cd dist && python3 -m http.server 4321
```

A one-shot production build:

```bash
npm run build
```

## Deploying to Vercel

The site is its own Vercel project, pointed at this subdirectory. Create the
project from the `jeremymcs/patchdeck` repository and set:

| Setting | Value |
| --- | --- |
| Root Directory | `site` |
| Framework Preset | `Other` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | `npm install` |

`vercel.json` handles caching (immutable for `/assets/*`) and the security headers.

### One thing to change after the domain is set

The canonical URL points at `https://patchdeck-eta.vercel.app/`, the alias Vercel
assigned this project.

> Do not "correct" this to `patchdeck.vercel.app`. That hostname is taken by an
> unrelated project ("PatchDeck — Visual Network Designer") and is not ours;
> pointing the canonical, OG image or sitemap at it would hand our SEO and link
> previews to a stranger's site.

Once a real domain is attached, update it in three places:

- `index.html` — `<link rel="canonical">`, the `og:url` / `og:image` /
  `twitter:image` meta tags, and the `url` field in the JSON-LD block
- `public/robots.txt` — the `Sitemap:` line
- `public/sitemap.xml` — the `<loc>` element

## Screenshots

Screenshots are pre-optimized and committed rather than converted during the
build, so the build stays reproducible on Vercel's Linux builders (the conversion
tooling here is macOS/Homebrew-local).

Sources live in `../docs/assets/`. To regenerate after new screenshots land,
with `webp` installed (`brew install webp`):

```bash
sips --resampleWidth 1920 ../docs/assets/PatchDeck-Dashboard.png --out /tmp/d.png
cwebp -q 80 -m 6 -sharp_yuv /tmp/d.png -o public/assets/patchdeck-dashboard.webp
```

The OG image is a 1200x630 top crop of the dashboard screenshot:

```bash
ffmpeg -i /tmp/d.png -vf "crop=1920:1006:0:0,scale=1200:630:flags=lanczos" \
  public/assets/og.png
```

Every `<img>` in `index.html` carries explicit `width`/`height` (1920x1080) to
prevent layout shift. Keep that in sync if the aspect ratio ever changes.

## Copy rules

Claims on the page trace back to the repository — `README.md`, `package.json`,
and the docs in `docs/public/`. No invented metrics, no testimonials, no user
counts. When PatchDeck's behaviour or defaults change, update the page:

- the version badge in the hero and the `softwareVersion` in the JSON-LD
- the safety section, which mirrors the defaults documented in the root `README.md`
- the issue label lists in the Issues feature section
