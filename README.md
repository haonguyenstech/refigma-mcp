<div align="center">

<img src=".github/assets/icon.png" width="112" alt="refigma-mcp icon" />

# refigma-mcp

**Read Figma frames from an AI agent without the REST API, plugins, or a paid seat.**

An [MCP](https://modelcontextprotocol.io) server that turns a Figma link into a layout tree, HTML / React + Tailwind,
SVG icons, design tokens and Figma's own PNG, then diffs your implementation against that PNG.

<p>
  <a href="https://github.com/saigontechnology/refigma-mcp/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/saigontechnology/refigma-mcp?color=6E56CF&logo=github" /></a>
  <img alt="Node ≥22.15" src="https://img.shields.io/badge/node-%E2%89%A522.15-339933?logo=node.js&logoColor=white" />
  <img alt="Python 3" src="https://img.shields.io/badge/python-3-3776AB?logo=python&logoColor=white" />
  <img alt="macOS | Windows" src="https://img.shields.io/badge/macOS%20%7C%20Windows-Microsoft%20Edge-0078D7?logo=microsoftedge&logoColor=white" />
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-6E7781" /></a>
</p>

<img src=".github/assets/hero.png" width="860" alt="A Figma frame on the left, its layout tree from refigma-mcp on the right, and the files it generates" />

<sub>Example: “Send – fee” from the <a href="https://bitcoin.design">Bitcoin Design</a> UI Kit (CC BY 4.0).</sub>

</div>

---

## Why

| | Figma REST API | Figma plugin | **refigma-mcp** |
| --- | --- | --- | --- |
| View / Collab seat | ~20 reads / month | can't run | **no quota** |
| Needs | a token | an Edit seat | a figma.com login in Edge |
| Code out of the box | no | depends | **HTML/CSS, React + Tailwind, SVG** |
| Verify an implementation | no | no | **pixel diff vs Figma's PNG** |

Generated HTML matches Figma's PNG at **98.6–99.98%** on 23 test frames ([details](#fidelity)).

---

## Install

**Requirements:** macOS or Windows 10/11 with **Microsoft Edge**, **Node ≥ 22.15**, **Python 3**
(macOS: plus `pip install cryptography`).

### 1. Download the package

From [Releases](https://github.com/saigontechnology/refigma-mcp/releases/latest), download
`refigma-mcp-<version>.tgz` into a folder of your own, e.g.

- macOS: `/Users/<you>/refigma/refigma-mcp-0.6.2.tgz`
- Windows: `C:\Users\<you>\refigma\refigma-mcp-0.6.2.tgz`

### 2. Add it to your client

Use the **full path** to the file. Note `--package=`: `npx <file.tgz>` alone does not work.

**Claude Desktop** — **Settings → Developer → Edit Config**, add under `mcpServers`:

<table>
<tr><th>macOS</th><th>Windows</th></tr>
<tr><td>

```json
"refigma-mcp": {
  "command": "npx",
  "args": ["-y",
    "--package=/Users/<you>/refigma/refigma-mcp-0.6.2.tgz",
    "refigma-mcp"]
}
```

</td><td>

```json
"refigma-mcp": {
  "command": "cmd",
  "args": ["/c", "npx", "-y",
    "--package=C:\\Users\\<you>\\refigma\\refigma-mcp-0.6.2.tgz",
    "refigma-mcp"]
}
```

</td></tr>
</table>

Then **quit** Claude Desktop completely (⌘Q / tray icon → Quit) and reopen it. **Settings → Developer** should show
`refigma-mcp` as **Running**. The first start takes ~20s while `npx` installs dependencies.

> Using an organization gateway? The config file is `Claude-3p/claude_desktop_config.json`
> (macOS `~/Library/Application Support/`, Windows `%LOCALAPPDATA%\`).

**Claude Code**

```bash
claude mcp add -s user refigma-mcp -- npx -y --package="$HOME/refigma/refigma-mcp-0.6.2.tgz" refigma-mcp
```

<details>
<summary><b>Not running?</b></summary>

Claude Desktop starts servers without your shell's `PATH`:

- macOS: set `"command"` to the output of `which npx`, and add `"env": { "PATH": "<folder of node>:/usr/bin:/bin" }`.
- Set `"REFIGMA_PYTHON"` in `env` to the full path of the Python that has `cryptography`.
- Log: macOS `~/Library/Logs/Claude/mcp-server-refigma-mcp.log`, Windows `%APPDATA%\Claude\logs\` (or `Claude-3p\logs\`).

</details>

### 3. Sign in to figma.com once

- **macOS:** the first capture copies your figma.com session from Edge. Click **Allow** on the Keychain prompt
  for *Microsoft Edge Safe Storage*.
- **Windows:** the first capture reports `NOT_LOGGED_IN`, the agent runs `figma_relogin`, and an Edge window opens.
  Sign in there once; the session is kept.

### Updating

New releases install themselves in the background (checked every 6h) and run from the next restart.
`figma_status` shows the running version. To update by hand: download the new `.tgz`, point the path in your config to
it, and restart.

---

## Usage

In Figma, right-click a frame → **Copy link to selection**, then ask:

> Implement this design: https://www.figma.com/design/AbCdEf123/App?node-id=3685-53706

The agent usually calls `figma_get_node` (layout tree) → `figma_get_assets` (icons, images) → `figma_get_code`
→ `figma_compare` against your dev server.

**CLI**, same outputs without an agent:

```bash
npx -y --package=/path/to/refigma-mcp-0.6.2.tgz figma-read "<figma link>" [out dir]
```

Output per node, in `~/.figma-local/out/<file>/<node>/`:

| File | What |
| --- | --- |
| `tree.txt` | the layout tree (what `figma_get_node` returns) |
| `index.html`, `<Component>.tsx` | HTML/CSS and React + Tailwind |
| `assets/icons/*.svg`, `assets/images/` | icons and original images |
| `tokens.json` | variables and styles in use |
| `frame.png` | Figma's own PNG |

---

## Tools

Every tool takes a `figma.com/design/…` link. `node_id` overrides the link's node; `refresh: true` skips the cache.

| Tool | Returns |
| --- | --- |
| `figma_get_node` / `figma_get_nodes` | Layout tree: auto layout, sizes, fills + tokens, typography, text, interactions. **Start here.** |
| `figma_get_metadata` | Pages and an outline (id, name, type, box) under the node. |
| `figma_search` | Layers whose name matches. |
| `figma_get_tokens` | Variables and named styles in use. |
| `figma_get_code` | HTML/CSS or React + Tailwind (`format=html\|react`). |
| `figma_get_assets` | SVG icons and images, optionally copied to `dest`. |
| `figma_export` | PNG / JPG / PDF of any node, 1x–4x. |
| `figma_get_image` | Figma's own PNG of the node. |
| `figma_compare` | Renders a URL, HTML file or `react` and diffs it with Figma's PNG: match %, worst regions, diff image. |
| `figma_relogin` | Refresh the figma.com session. |
| `figma_status` | Version, browser, cached captures. |

---

## How it works

A private headless Edge opens the link, records Figma's multiplayer WebSocket (the whole page, components and
variables) and triggers Figma's own copy handler. The data is decoded locally (`kiwi-schema`, zstd) into a model,
then into code. Images come from Figma's `image/batch` endpoint with the browser session, so no token or quota.

| Call | Time |
| --- | --- |
| Captured in the last 12h | instant |
| Another node on a page recorded in the last 30 min | ~3–5s |
| First node of a page | ~15s (~6s on a small file) |
| `figma_get_image` / `figma_compare` without a PNG yet | ~25–35s |

## Fidelity

Generated HTML vs Figma's PNG on public files:

| Frame | Match |
| --- | ---: |
| [Bitcoin UI Kit](https://www.figma.com/design/VB3GQdAnhl8yta44DY3PSV/Bitcoin-UI-Kit) · 5 frames | 98.58–99.67% |
| [DashPay Android](https://www.figma.com/design/84tUBQA9DYU1svyQx8tnbk/DashPay---Android) · Welcome | 99.59% |
| [WallGodds](https://www.figma.com/design/rsOU06uLMMhLJOgw7SUhWt/Wallgodds) · Sign In | 99.31% |
| [DGA components](https://www.figma.com/design/I2E5M7OWeToi3moSfwoRfH/Components-Library---Platforms-Code--Community-) · Button sheet | 99.86% |
| [IMDb Redesign](https://www.figma.com/design/1sIRD12ImqTbC6lI396gWA/IMDb-Redesign) · Reviews | 99.79% |
| [Social Media Dashboard](https://www.figma.com/design/7dkR8zP71qc5MtUFCPi7Hd) | 98.70% |
| [BizRank UI](https://www.figma.com/design/UGugSfQCkplaBzaCzS6MC7/BizRank-UI) · login | 99.89% |
| 12 production frames | 99.07–99.98% |

React renders identically to the HTML. The rest is mostly font anti-aliasing and fonts Google Fonts doesn't have.

---

## Configuration

Set in the `env` block of the MCP config.

| Variable | Default | Effect |
| --- | --- | --- |
| `REFIGMA_PYTHON` | `python3` / `python`, `py -3` | Python 3 interpreter |
| `REFIGMA_AUTO_UPDATE` | `1` | `0` turns self-update off |
| `REFIGMA_CACHE_MAX_AGE` | `43200` | Seconds a capture is reused |
| `REFIGMA_DOC_MAX_AGE` | `1800` | Seconds a recorded page serves node data |
| `REFIGMA_SOURCE=clipboard` | — | Always capture live |
| `REFIGMA_CDP` | — | Capture in another browser, e.g. `9222` |
| `REFIGMA_EDGE_PROFILE` | Edge `Default` | macOS: profile the session is copied from |
| `FIGMA_API_KEY` | — | Fallback for images `image/batch` could not resolve; rarely needed |

Cache lives in `~/.figma-local/out/`; deleting it is safe.

---

## Development

```bash
git clone https://github.com/saigontechnology/refigma-mcp && cd refigma-mcp && npm install
claude mcp add -s user refigma-mcp -- node "$PWD/server.mjs"
```

**Release:** `npm version x.y.z --no-git-tag-version`, commit and push, `npm pack`, then
`gh release create vx.y.z refigma-mcp-x.y.z.tgz`. Installed copies pick it up by themselves.

## Limitations

- Relies on Figma's undocumented clipboard and multiplayer formats; a Figma release can break it.
- Not rendered yet: grid auto layout, angular/diamond gradients in icons, corner smoothing, boolean EXCLUDE. FigJam is WIP.
- Frames are static (exact px, no responsive behaviour).
- The capture browser's CDP port (`:9334`) is unauthenticated and holds a signed-in figma.com session.

<div align="center"><sub>MIT License · Not affiliated with Figma · Built with <a href="https://github.com/evanw/kiwi">kiwi-schema</a>, <a href="https://github.com/mapbox/pixelmatch">pixelmatch</a>, <a href="https://esbuild.github.io">esbuild</a>, the <a href="https://github.com/modelcontextprotocol/typescript-sdk">MCP SDK</a></sub></div>
