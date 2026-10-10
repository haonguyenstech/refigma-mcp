# refigma-mcp

Read Figma frames from an AI agent **without the REST API, plugins, or a paid seat**. Works on
View/Collab seats, which are otherwise limited to ~20 REST reads per month and can't run plugins.

How: a logged-in debug Edge (CDP `:9222`) opens the link, Figma's own copy handler is triggered on the
selected node, and the clipboard payload (`fig-kiwi` binary) is decoded locally into a layout tree.

## Tools

| Tool | Returns |
| --- | --- |
| `figma_get_node(url, refresh?, max_lines?)` | Layout tree: row/col, gap, padding, align, size, fills with token names, borders, radius, shadow, fonts, text. Instances expanded with overrides. |
| `figma_get_image(url, refresh?)` | 1x PNG of the node (needs the debug Edge window visible). |
| `figma_get_tokens(url, refresh?)` | Design tokens (Figma variables) + text styles used by the node. |
| `figma_status()` | Debug browser / cache status. |

Captures are cached in `~/.figma-local/out/<fileKey>/<node>/` — pass `refresh: true` after design changes.

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
- Not every component-property case is resolved (e.g. some icon leading/trailing toggles); trust the PNG when they disagree.
