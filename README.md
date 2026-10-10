# refigma-mcp

Read Figma frames from an AI agent **without the REST API, plugins, or a paid seat**. Works on
View/Collab seats, which are otherwise limited to ~20 REST reads per month and can't run plugins.

How: a private **headless** Edge (no window, no Figma Desktop; `lib/browser.mjs`, CDP `:9334`) opens the link, Figma's own copy handler is triggered on the
selected node, and the clipboard payload (`fig-kiwi` binary) is decoded locally into a layout tree.

## Tools

| Tool | Returns |
| --- | --- |
| `figma_get_metadata(url, node_id?, depth?)` | Pages of the file + sparse XML outline (id, name, type, x, y, w, h) of the recorded page(s) or under a node. |
| `figma_search(url, query)` | Layers matching a name, with path. |
| `figma_get_node(url, node_id?)` | Layout tree: auto-layout, sizes, fills with token names, strokes, radius, shadows, typography, text, **style names**, **prototype interactions**, **hover variants**, **annotations**. |
| `figma_get_nodes(url, node_ids[])` | Several trees at once; nodes on a recorded page come from the document in seconds. |
| `figma_get_code(url, format=html\|react)` | Deterministic HTML/CSS or React + Tailwind (arbitrary values), incl. `:hover` + transitions from prototype hover variants. |
| `figma_get_assets(url, dest?)` | SVG icons from vector geometry (named after components) + original images. |
| `figma_export(url, node_id?, png\|jpg\|pdf, scale)` | Any node at 1x–4x; PNG transparent, PDF vector — rendered from the verified HTML. |
| `figma_get_tokens(url)` | Variables (CSS var, rendered value, per-mode values) + named text/fill/effect styles with values. |
| `figma_get_image(url)` | Figma's own 1x PNG (ground truth). |
| `figma_compare(url, target?)` | Pixel diff of a URL / HTML file / `react` vs Figma's PNG: match %, worst regions, diff image. |
| `figma_relogin()` | Re-imports the figma.com session from the real Edge profile (Keychain prompt). |
| `figma_status()` | Browser, recorded documents, cached captures. |

Measured on the test frame: generated HTML **and** React+Tailwind both match Figma's render at **99.975%** of pixels.

## How a capture works

`lib/capture.mjs` drives the headless Edge over one CDP session (`REFIGMA_CDP=9222` to watch it in the visible debug Edge):
- blocks FigmaAgent (`127.0.0.1:44950`), so Figma Desktop never pops up, and closes the resulting
  "Need to use the desktop app or installed fonts?" dialog (it steals focus from the Copy-as-PNG shortcut);
- the headless browser uses a normal Edge user agent (Figma's CDN rejects `HeadlessChrome`) and no automation flag;
- auto-attaches workers and records the multiplayer WebSocket: a `fig-wire` schema frame + `NODE_CHANGES`
  holding the entire loaded page (≈150k nodes incl. all components, variables, vector blobs) → `lib/doc.mjs`;
- triggers Figma's own copy handler (`execCommand('copy')` on `input.focus-target`) for the node and Copy-as-PNG.

## What makes it faithful

- Instances are expanded the way Figma does: `guidPath` overrides (instance boundaries only), component properties
  (boolean / text / instance swap, defaults from the component set), variant swaps reset to the new variant's styling.
- Variable-bound colours are resolved through alias chains in the active mode — the paint's cached colour can be stale.
- `stackReverseZIndex` ("first on top") becomes z-index; uniform strokes become `outline` with negative offset
  (no layout impact, painted above children, like Figma); gradient strokes use a masked `::before`.
- Comparison runs in a separate headless Edge with `--force-color-profile=srgb`: macOS Edge otherwise renders in
  Display P3 and every saturated colour is off.

## Setup

```bash
npm install
claude mcp add -s user refigma-mcp -- node ~/coding/js/refigma-mcp/server.mjs
```

The headless browser takes the figma.com session from the debug Edge if it is running, else from the real
Microsoft Edge profile (one Keychain prompt). `figma_relogin` refreshes it from the real Edge. CLI: `bin/figma-read <url> [outdir]`.

## Caveats

- Relies on Figma's undocumented clipboard format; may break when Figma changes it.
- Figma loads pages lazily: metadata/search cover the page(s) loaded by the last capture.
- FigJam: geometry renderer started (`figjam_svg`), not finished/verified yet.
- Fonts missing from Google Fonts fall back; boolean SUBTRACT/INTERSECT use SVG masks (approximate for exotic cases).
- A static frame has no hover/responsive behaviour; sizes are exact px with hug/fill recorded in the tree.
- Images whose URL isn't in the clipboard are fetched via REST image-fills (Tier 2: per-minute quota) with `FIGMA_API_KEY`/`FIGMA_ACCESS_TOKEN`.
