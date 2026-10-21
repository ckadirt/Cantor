# cantorfm.com

The landing and the docs, in [Astro](https://astro.build) with
[Starlight](https://starlight.astro.build) for the docs' frame (left bar,
search, table of contents, prev/next).

```sh
cd docs
npm ci
npm run dev       # http://localhost:4321
npm run build     # static site in dist/, search index included
```

## Add a page

Write Markdown in `src/content/docs/docs/`. The path is the URL:
`src/content/docs/docs/node/status.md` is `/docs/node/status/`.

```md
---
title: cantor status
description: What the node is doing, in one screen.
eyebrow: The node · Running
sidebar:
  order: 2
---

## Usage
...
```

- `title` names the page and draws its marks. A title that starts with
  `cantor ` prints `cantor` faint and the command in full ink.
- `description` is the lead under the title.
- `eyebrow` is the small line above it.
- `mark` (optional) draws the marks from another name, so renaming a page can
  keep its seal.

Every `##` is a measure: it is numbered and ticked on the page's spine on its
own. Then list the page in its sidebar group in `astro.config.mjs`; the node's
commands are grouped by family there. Asides use Starlight's syntax
(`:::note`, `:::caution`).

## The art

Every drawing is the app's own geometry, imported from `cantor/src/lenses` and
`cantor/src/marks` (`src/lib/art.ts`, `src/scripts/bath.ts`). A page's name
stands in for a song's recipe, so a page's seal is the one the app would draw
for that recipe. Do not copy the geometry here; import it.

| Component | Draws | When |
| --- | --- | --- |
| `art/Seal.astro` | the seal, at mark depth (2) or player depth (3) | build time, SVG |
| `art/Face.astro` | the circle | build time, SVG |
| `art/Station.astro`, `art/Phone.astro` | a node's and a phone's marks | build time, SVG |
| `art/Marbling.astro` | the marbling, still or `live` | in the browser, canvas |

Starlight's own pieces that are replaced live in `components/starlight/`:
the site title (with the site's seal), the page title (with the page's
marbling plate), the right margin (the page's seal, which plays as you read),
and prev/next (the coda). The palette and type are `styles/tokens.css` and
`styles/theme.css`: black and white, greys for hierarchy, no hue.

## Links

The install line and the APK link live in `src/site.ts`. `public/_redirects`
sends `/install.sh` to the relay's copy, so the published command is
`curl -fsSL https://cantorfm.com/install.sh | sh` once the site is deployed.
