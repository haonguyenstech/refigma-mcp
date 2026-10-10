# refigma-mcp

Read Figma frames from an AI agent **without the REST API, plugins, or a paid seat**. Works on
View/Collab seats, which are otherwise limited to ~20 REST reads per month and can't run plugins.

How: a logged-in debug Edge (CDP `:9222`) opens the link, Figma's own copy handler is triggered on the
selected node, and the clipboard payload (`fig-kiwi` binary) is decoded locally into a layout tree.

## Tools

| Tool | Returns |
| --- | --- |
| `figma_get_node(url)` | Layout tree: auto-layout (dir, gap, padding, align, hug/fixed, fill, wrap, absolute), size/rotation, fills (token names, gradients, images), strokes per side, radius per corner, shadow/blur params, typography (weight, line-height, letter-spacing, alignment, mixed runs), text. |
| `figma_get_html(url)` | Deterministic HTML/CSS generated from the data — the source of truth for implementation. |
| `figma_get_assets(url, dest?)` | SVG icons built from vector geometry (named after components) + downloaded images; optional copy into a project. |
| `figma_get_tokens(url)` | Figma variables used: CSS var, rendered value, values per mode. |
| `figma_get_image(url)` | Figma's own 1x PNG of the node. |
| `figma_compare(url, target?)` | Pixel diff of `target` (URL or HTML file; default the generated HTML) vs Figma's PNG in an sRGB headless Edge: match %, worst regions, diff image. |
| `figma_status()` | Debug browser / cache status. |

Captures are cached in `~/.figma-local/out/<fileKey>/<node>/` — pass `refresh: true` after design changes.
On the first test frame the generated HTML matches Figma's render at **99.975%** of pixels (the rest is glyph anti-aliasing).

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

The debug Edge must be logged in to figma.com once (import cookies from the real Edge with the
`import-cookie` skill, or log in by hand in the window `connect.sh` opens). CLI: `bin/figma-read <url> [outdir]`.

## Caveats

- Relies on Figma's undocumented clipboard format; may break when Figma changes it.
- Opening a `/design/` link also triggers Figma Desktop if "open links in desktop app" is on.
- Fonts missing from Google Fonts fall back; boolean SUBTRACT/INTERSECT use SVG masks (approximate for exotic cases).
- A static frame has no hover/responsive behaviour; sizes are exact px with hug/fill recorded in the tree.
- Images whose URL isn't in the clipboard are fetched via REST image-fills (Tier 2: per-minute quota) with `FIGMA_API_KEY`/`FIGMA_ACCESS_TOKEN`.
