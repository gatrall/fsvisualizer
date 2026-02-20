# FeatureScript Stdlib Visualizer (MVP)

Minimal tool to index local Onshape FeatureScript stdlib files and explore their import/re-export graph in a browser UI.

## Requirements

- Node.js 20+
- Local stdlib folder containing `.fs` files (for example, a clone of `javawizard/onshape-std-library-mirror`, preferably branch `without-versions`)

## Setup

```bash
npm install
```

## Build Graph JSON

```bash
npm run index -- --root /path/to/onshape-std-library-mirror
```

This writes `public/graph.json`.

## Run Dev UI

```bash
npm run dev
```

Then open the URL shown by Vite (typically [http://localhost:5173](http://localhost:5173)).

## Fully Automated Updates + Hosting (GitHub Pages)

You can run this with no ongoing manual work once enabled.

- Workflow file (repo root): `../.github/workflows/fsvisualizer-pages.yml`
- What it does:
  - runs weekly (Monday at 09:17 UTC) and on manual trigger
  - clones canonical stdlib mirror (`javawizard/onshape-std-library-mirror`, branch `without-versions`)
  - regenerates `public/graph.json`
  - builds and deploys to GitHub Pages
- It also runs on pushes to `main` when app/indexer files change.

### One-time setup in GitHub

1. Push this repo to GitHub.
2. In repo settings, open **Pages** and set source to **GitHub Actions**.
3. Run the **Deploy Graph Viewer** workflow once (or wait for schedule).

After that, the site stays current automatically on schedule.

## Features

- Recursive `.fs` indexing
- Regex-based parsing for:
  - `import(path : "...", version : "...");`
  - `export import(path : "...", version : "...");`
- Best-effort comment stripping to avoid matching commented-out imports
- Deduplicated import/re-export edges
- Optional exported symbol extraction:
  - `export function NAME`
  - `export type NAME`
  - `export predicate NAME`
  - `export enum NAME`
  - `export const NAME`
- Cytoscape graph rendering with pan/zoom
- Left sidebar search + navigation
- Right details panel with clickable imports/reexports
- Graph usability controls:
  - Search filters the graph (not just the list)
  - View modes: search-only, search+neighbors, selected+1 hop, selected+2 hops, full
  - Folder scope filter (top-level path grouping)
  - Layout switcher (concentric, breadthfirst, COSE, circle)
  - Edge visibility toggles (`import` / `reexport`)
  - Label toggle and quick relayout/fit buttons

## Scripts

- `npm run dev` - Start Vite dev server
- `npm run build` - Build production assets
- `npm run index -- --root <dir>` - Index FeatureScript tree and emit `public/graph.json`
- `npm run preview` - Preview built app
