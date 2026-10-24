<div align="center">

<img src=".github/assets/icon.png" width="112" alt="refigma-mcp icon" />

# refigma-mcp

**Read Figma frames from an AI agent without the REST API, plugins, or a paid seat.**

An [MCP](https://modelcontextprotocol.io) server that turns a Figma link into a layout tree, pixel-faithful HTML / React + Tailwind,
SVG icons, design tokens and Figma's own PNG, then checks your implementation against that PNG pixel by pixel.

<p>
  <a href="https://github.com/haonguyenstech/refigma-mcp/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/haonguyenstech/refigma-mcp?color=6E56CF&logo=github" /></a>
  <img alt="MCP server" src="https://img.shields.io/badge/MCP-stdio%20server-6E56CF" />
  <img alt="Node ≥22.15" src="https://img.shields.io/badge/node-%E2%89%A522.15-339933?logo=node.js&logoColor=white" />
  <img alt="Python 3" src="https://img.shields.io/badge/python-3-3776AB?logo=python&logoColor=white" />
  <img alt="macOS | Windows" src="https://img.shields.io/badge/macOS%20%7C%20Windows-Microsoft%20Edge-0078D7?logo=microsoftedge&logoColor=white" />
  <img alt="Pixel match" src="https://img.shields.io/badge/pixel%20match-99.07%E2%80%9399.98%25-success" />
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-6E7781" /></a>
</p>

<a href="#features">Features</a> ·
<a href="#getting-started">Getting started</a> ·
<a href="#guide">Guide</a> ·
<a href="#tools">Tools</a> ·
<a href="#how-it-works">How it works</a> ·
<a href="#configuration">Configuration</a> ·
<a href="#limitations">Limitations</a>

<br /><br />

<img src=".github/assets/hero.png" width="860" alt="A Figma frame on the left, its layout tree from refigma-mcp on the right, and the files it generates" />

<sub>Example: “Send – fee” from the <a href="https://bitcoin.design">Bitcoin Design</a> UI Kit (CC BY 4.0).</sub>

</div>

---

## Features

### 🔓 Works on a View seat
| | Figma REST API | Figma plugin | **refigma-mcp** |
| --- | --- | --- | --- |
| View / Collab seat | ~20 reads / month | can't run | **no quota** |
| Needs | a token | an Edit seat | a figma.com login in Edge |
| Code out of the box | no | depends on the plugin | **HTML/CSS, React + Tailwind, SVG** |
| Verify an implementation | no | no | **pixel diff vs Figma's PNG** |

### 🌳 A layout tree an agent can read
Auto layout, sizes, fills with token names, strokes, radius, shadows, typography, text, style names, prototype interactions, hover variants and Dev Mode annotations, one line per layer. Instances are expanded the way Figma does it.

### 🧱 Code, icons and tokens
Deterministic HTML/CSS or a React component with Tailwind arbitrary values (incl. `:hover` from prototype variants), SVG icons named after their components, the original images, and every variable and style in use.

### 🎯 Checks your implementation
`figma_compare` renders your running app, an HTML file or the generated React in an sRGB headless Edge and diffs it with Figma's own PNG: match %, the worst regions and a diff image. Generated HTML scores **99.07–99.98%** on 12 production frames, see [Fidelity](#fidelity).

### ⚡ Fast after the first call
The first node of a page takes ~15s (mostly Figma sending the page; ~6s on a small file). Every other node on that page then comes from the recorded document in ~3–5s, without a browser. Figma's own PNG (`figma_get_image`, `figma_compare`) still needs a full live capture, ~25–35s. See [Speed](#speed).

### 🛡️ Quiet and safe
A private headless Edge, no window, no Figma Desktop popping up; several agent sessions at once; design content treated as untrusted input. See [Reliability and safety](#reliability-and-safety).

---

## Getting started

### Requirements
- **macOS or Windows 10/11** with **Microsoft Edge**
- **Node ≥ 22.15**, **Python 3**, `curl` (built into both)
- On macOS: Edge signed in to figma.com, and Python's `cryptography` (to read that session)

### Install

```bash
claude mcp add -s user refigma-mcp -- npx -y https://github.com/haonguyenstech/refigma-mcp/releases/download/v0.6.2/refigma-mcp-0.6.2.tgz
```

The package is the `.tgz` attached to each [GitHub release](https://github.com/haonguyenstech/refigma-mcp/releases):
`npx` downloads it on first use and keeps it cached. Nothing to clone, no npm account. Any other MCP client takes
the same command:

```json
{ "mcpServers": { "refigma-mcp": { "command": "npx", "args": ["-y", "https://github.com/haonguyenstech/refigma-mcp/releases/download/v0.6.2/refigma-mcp-0.6.2.tgz"] } } }
```

For a global install instead: `npm install -g <the .tgz URL>`, then use `refigma-mcp` as the command.

### Claude Desktop

refigma-mcp runs on your machine (stdio), so it is added through the config file, not
**Settings → Connectors → Add custom connector** (that dialog only takes a remote HTTPS URL).

<p align="center"><sub>macOS version (63 s, no sound): <a href="https://pub-ad81218f6d26484ab3b7b9f714c38911.r2.dev/videos/claude-desktop-setup.mp4">watch the MP4</a> · both videos re-enact the steps below</sub></p>

<p align="center"><a href="https://pub-ad81218f6d26484ab3b7b9f714c38911.r2.dev/videos/claude-desktop-windows-setup.mp4"><img src=".github/assets/claude-desktop-windows-setup.jpg" width="100%" alt="Play the Windows setup video: winget install, the cmd /c npx config, quit from the tray, check Running, Connectors, Figma sign-in"></a></p>

1. In Claude Desktop open **Settings → Developer → Edit Config**. This opens `claude_desktop_config.json`:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
2. Add `refigma-mcp` under `mcpServers` (keep any servers already there):

   ```json
   {
     "mcpServers": {
       "refigma-mcp": {
         "command": "npx",
         "args": ["-y", "https://github.com/haonguyenstech/refigma-mcp/releases/download/v0.6.2/refigma-mcp-0.6.2.tgz"],
         "env": { "FIGMA_API_KEY": "figd_… (optional, see Configuration)" }
       }
     }
   }
   ```

   Drop the `env` block if you have no Figma token; every other variable from [Configuration](#configuration) goes there too.

   **Windows:** Claude Desktop cannot start `npx` directly there (`spawn npx ENOENT`: it is `npx.cmd`), so run it
   through `cmd /c`:

   ```json
   "refigma-mcp": {
     "command": "cmd",
     "args": ["/c", "npx", "-y", "https://github.com/haonguyenstech/refigma-mcp/releases/download/v0.6.2/refigma-mcp-0.6.2.tgz"]
   }
   ```
3. **Quit** Claude Desktop completely (⌘Q on macOS; on Windows, quit from the tray icon) and open it again.
   Closing the window is not enough: the config is only read at startup.
4. **Settings → Developer** lists `refigma-mcp` as **Running** (if not, **View logs** shows why). In a new chat, open
   the **+** menu → **Connectors** (or the tools icon): `refigma-mcp` is listed with its
   `figma_*` tools. Paste a frame link and ask, as in the [Guide](#guide).

New releases install themselves from then on; see [Updating in Claude Desktop](#updating-in-claude-desktop).

**If it does not show up** — Claude Desktop starts the server without your shell's `PATH`, so it may not find
`npx`, a recent enough Node, or the Python that has `cryptography`:

- Use absolute paths: `"command"` = output of `which npx` (Windows: `where npx`, the `npx.cmd` line), and add
  `"PATH"` to `env` with the folder of that `node` first, e.g. `"PATH": "/opt/homebrew/bin:/usr/bin:/bin"`.
  With nvm the folder is `~/.nvm/versions/node/<version>/bin`.
- Set `"REFIGMA_PYTHON"` in `env` to the full path of your `python3` (Windows: `python.exe`).
- Read the server log: macOS `~/Library/Logs/Claude/mcp-server-refigma-mcp.log`,
  Windows `%APPDATA%\Claude\logs\mcp-server-refigma-mcp.log`.

Sign-in works as below: the macOS Keychain prompt and the Windows `figma_relogin` window appear the same way
under Claude Desktop.

Using Claude Desktop through [ccgw](https://github.com/haonguyenstech/ccgw)? `ccgw connector add refigma` writes the entry for you.

### Sign in to figma.com once

**macOS:** on the first capture the server copies your figma.com session from Edge. macOS shows a Keychain prompt
for **Microsoft Edge Safe Storage**: click **Allow**. If captures later report `NOT_LOGGED_IN`, run `figma_relogin`.

**Windows:** Edge's cookies there are app-bound encrypted and locked while Edge runs, so they cannot be copied.
The first capture reports `NOT_LOGGED_IN` and the agent calls `figma_relogin`, which opens an Edge window on
refigma's own profile at figma.com/login. Sign in there once (within 5 minutes); the profile keeps the session and
captures run headless from then on. Python from python.org or the Microsoft Store both work (`python` or `py -3`).

---

## Guide

### 1. Copy a link to a frame

In Figma, right-click a frame → **Copy link to selection**. The link carries the `node-id` of that frame.

### 2. Ask the agent

> Implement this design: https://www.figma.com/design/AbCdEf123/App?node-id=3685-53706

A typical agent run calls `figma_get_node` for the layout tree, `figma_get_assets` for icons and images,
`figma_get_code` as a starting point, and finally `figma_compare` against your dev server to check the result.

> 📌 Every answer states where the data came from (cache, recorded document or live capture) and how old it is. Pass `refresh: true` to capture again.

### 3. Or run it yourself with the CLI

`figma-read` writes the same outputs as the server:

```bash
npx -p https://github.com/haonguyenstech/refigma-mcp/releases/download/v0.6.2/refigma-mcp-0.6.2.tgz figma-read "<figma link>" [out dir]
```

<p align="center"><img src=".github/assets/figma-read.png" width="860" alt="figma-read on a Figma link: OK, 85 nodes, 9 icons, component SendFee.tsx"></p>

One folder per node, default `~/.figma-local/out/<file>/<node>`:

<p align="center"><img src=".github/assets/outputs.png" width="760" alt="The output folder: tree.txt, index.html, SendFee.tsx, tokens.json, frame.png, assets/icons"></p>

| File | What |
| --- | --- |
| `tree.txt` | the layout tree, the same text `figma_get_node` returns |
| `index.html` | HTML/CSS that renders the frame |
| `<Component>.tsx` | React + Tailwind version of the same |
| `assets/icons/*.svg`, `assets/images/` | icons from vector geometry, original images |
| `tokens.json` | variables and styles in use |
| `frame.png` | Figma's own 1x PNG, the ground truth for `figma_compare` |
| `msg.json(.gz)`, `model.json` | the decoded copy data and normalized model, for re-generating |

The tree is what the agent reads first:

<p align="center"><img src=".github/assets/tree.png" width="860" alt="tree.txt: frames with auto layout, instances with their variants, text with font and style names"></p>

---

## Tools

Every tool takes a `figma.com/design/…` link; branch links (`…/branch/<key>/…`) read the branch. `node_id` accepts
`3685:53706`, `3685-53706` and instance ids (`I123:45;67:89`) and overrides the link's `node-id`. `refresh: true`
captures again instead of using the cache. Every answer states where the data came from and how old it is.

### Read the design

| Tool | Returns |
| --- | --- |
| `figma_get_metadata(url, node_id?, depth?, max_lines?)` | The file's pages and a sparse XML outline (id, name, type, x, y, w, h) under the link's node. Records the node's page if it was not recorded yet. Truncated at 1000 lines. |
| `figma_search(url, query, limit?)` | Layers whose **name** matches (not text content), with their path, on the recorded pages. |
| `figma_get_node(url, node_id?, max_lines?)` | The layout tree: auto layout, sizes, fills with token names, strokes, radius, shadows, typography, text, style names, prototype interactions, hover variants, Dev Mode annotations. Start here. |
| `figma_get_nodes(url, node_ids[], max_lines_each?)` | Several trees at once; nodes on a recorded page come from the document in seconds; an invalid id fails alone. |
| `figma_get_tokens(url)` | Variables (CSS variable, rendered value, values per mode) and the named text / fill / effect styles in use. |

### Generate

| Tool | Returns |
| --- | --- |
| `figma_get_code(url, format=html\|react, path_only?)` | Deterministic HTML/CSS, or a React component with Tailwind arbitrary values, incl. `:hover` rules and transitions from prototype hover variants. |
| `figma_get_assets(url, dest?)` | SVG icons built from vector geometry (named after their components) and the original images. A relative `dest` is resolved against your working directory; replaced files are listed. |
| `figma_export(url, node_id?, format=png\|jpg\|pdf, scale?, dest?)` | Any node at 1x–4x: transparent PNG, JPG or vector PDF, rendered from the verified HTML. |

### Verify

| Tool | Returns |
| --- | --- |
| `figma_get_image(url)` | Figma's own 1x PNG of the node — the ground truth. Images over 7900px or 5MB come back as a path. |
| `figma_compare(url, target?, selector?, viewport?, local_storage?, settle_ms?)` | Renders `target` (a URL, an HTML file, or `react`; default: the generated HTML) in an sRGB headless Edge and diffs it with Figma's PNG: match %, the worst regions and a diff image. |

`figma_compare` against a running app:

```jsonc
{
  "url": "https://www.figma.com/design/AbCdEf123/App?node-id=3685-53706",
  "target": "http://localhost:5173/notifications",
  "selector": "[data-testid=notification-popover]", // diff just this element
  "viewport": "1440x1024",
  "local_storage": { "token": "<access token>" },  // for pages behind a login
  "settle_ms": 1500                                 // wait for client-side rendering
}
```

### Session

| Tool | Does |
| --- | --- |
| `figma_relogin()` | macOS: copies the figma.com session from your real Edge profile again (Keychain prompt) and checks it. Windows: opens an Edge window to sign in to figma.com once. |
| `figma_status()` | The headless browser, recorded documents, and cached captures with their age. |

---

## How it works

```mermaid
flowchart LR
    A[Figma link] --> B{fresh cache?}
    B -- yes --> OUT
    B -- no --> C{page recorded in<br/>the last 30 min?}
    C -- yes --> D[page document<br/>no browser, ~3-5s]
    C -- no --> R[record the page<br/>headless Edge, ~15s]
    R --> G[multiplayer socket<br/>whole page, ~150k nodes]
    G --> D
    C -. PNG needed .-> E[live capture<br/>~25-35s]
    E --> F[Figma's copy handler<br/>fig-kiwi + PNG]
    F --> X[extract.py]
    D --> X
    X -. image URLs .-> I[image/batch<br/>~0.3s]
    X --> OUT[tree.txt · index.html · Component.tsx<br/>assets/ · tokens.json · frame.png]
```

A private **headless** Edge (no window, no Figma Desktop, CDP on `:9334`) opens the link in its own tab and:

- blocks FigmaAgent (`127.0.0.1:44950`), so Figma Desktop never pops up, and closes the
  *"Need to use the desktop app or installed fonts?"* dialog that would steal focus from Copy-as-PNG;
- uses a normal Edge user agent (Figma's CDN rejects `HeadlessChrome`) and no automation flag;
- records the multiplayer WebSocket: a `fig-wire` schema frame plus `NODE_CHANGES` with the whole loaded page,
  including components, variables and vector blobs;
- triggers Figma's own copy handler (`execCommand('copy')` on `input.focus-target`) and Copy-as-PNG for the node.

The clipboard payload and the page document are decoded locally (`kiwi-schema`, zstd / deflate) and turned into a
normalized model, then into code.

---

## Fidelity

Generated HTML compared with Figma's PNG, on 12 frames of two production files:

| Frames | Before the pixel-bench fixes | Now |
| --- | ---: | ---: |
| Modal with variant-driven icons | 58.8% | **99.83%** |
| Code / XML viewer | 65.0% | **99.40%** |
| Page with rotated scroll bars | 92.5% | **99.91%** |
| Notification popover | 97.1% | **99.07%** |
| The other 8 | 98.9–99.98% | **99.07–99.98%** |

And on public files anyone can open (frame links from GitHub READMEs), before and after the fixes of v0.6:

| Frame | Before | Now |
| --- | ---: | ---: |
| [Bitcoin UI Kit](https://www.figma.com/design/VB3GQdAnhl8yta44DY3PSV/Bitcoin-UI-Kit) · Send - recipient (`26-708`) | 79.0% | **99.49%** |
| Bitcoin UI Kit · Home (`5629-16191`) | 90.8% | **99.54%** |
| Bitcoin UI Kit · Transactions (`1904-499`) | 93.1% | **98.58%** |
| Bitcoin UI Kit · Send - fee (`26-1292`) | 95.0% | **98.91%** |
| Bitcoin UI Kit · `1903-54056` | 99.3% | **99.67%** |
| [DashPay Android](https://www.figma.com/design/84tUBQA9DYU1svyQx8tnbk/DashPay---Android) · Welcome (`30036-6698`) | 69.3% | **99.59%** |
| [WallGodds](https://www.figma.com/design/rsOU06uLMMhLJOgw7SUhWt/Wallgodds) · Sign In, mobile (`3547-517`) | 84.7% | **99.31%** |
| [DGA components](https://www.figma.com/design/I2E5M7OWeToi3moSfwoRfH/Components-Library---Platforms-Code--Community-) · Button sheet (`407-510376`, 6.8k layers) | 99.34% | **99.86%** |
| [IMDb Redesign](https://www.figma.com/design/1sIRD12ImqTbC6lI396gWA/IMDb-Redesign) · Reviews (`51-781`) | 99.79% | **99.79%** |
| [Social Media Analytics Dashboard](https://www.figma.com/design/7dkR8zP71qc5MtUFCPi7Hd) · Dashboard (`2-977`) | 93.1% | **98.70%** |
| [BizRank UI](https://www.figma.com/design/UGugSfQCkplaBzaCzS6MC7/BizRank-UI) · login, Japanese (`1220-103`) | 99.89% | **99.89%** |

React + Tailwind renders pixel-identical to the HTML on all of these. The remaining difference is mostly text
anti-aliasing and font metrics, plus fonts Google Fonts does not have (WallGodds uses a local font) or serves without
an OpenType feature the design turns on (Inter's slashed zero).

<details>
<summary><b>What makes it faithful</b></summary>

- **Instances are expanded the way Figma does it:** `guidPath` overrides at instance boundaries only; component
  properties (boolean / text / instance swap), with defaults from the component set; values read from `value` or, in
  newer files, `varValue` (incl. variable-bound booleans). Variant swaps reset to the new variant's styling.
- **Styles win over cached paints:** library shadow, image fill and text style references resolve to the style's
  current values, for every node, across several override entries of one node, and in text runs. Figma's copy
  handler skips them inside overrides, so this fixes clipboard output too.
- **Masks, crops, aligned strokes:** mask layers (flagged `mask` in newer files) clip their siblings by outline, alpha
  or luminance; cropped images keep the crop; inside/outside strokes of icons stay inside/outside; a frame's stroke
  paints over absolutely positioned children; layer blur and drop shadows apply to icons too.
- **Absent fields mean the default:** a missing right/bottom padding is 0, not the left/top value (checked on 155
  hugging frames); a vector loop may start with a reversed segment.
- **Variables:** bound colours resolve through alias chains in the active mode (a paint's cached colour can be stale).
  Figma mirrors a bound colour's alpha into the paint opacity; it is applied once. A token painted in another mode
  inside the frame keeps its own colour.
- **Transforms:** rotations and flips use the full matrix; in auto layout the rotated bounding box takes the slot.
- **Strokes paint above children,** like Figma's: uniform strokes become `outline` with a negative offset (no layout
  impact), per-side strokes an `::after` border, gradient strokes a masked `::before`.
- **Layer order:** "first on top" stacks become z-index inside an isolated stacking context, so it stays local.
- **Shapes:** mask layers clip the layers above them; arcs (pie / donut); per-corner radii in SVG; SUBTRACT /
  INTERSECT through SVG masks; unique, stable SVG ids.
- **Text:** mixed runs, paragraph spacing, wrapping of over-long words, truncation with line clamp, text shadows.
- **Colour:** comparison renders with `--force-color-profile=srgb`; macOS Edge otherwise renders in Display P3 and
  every saturated colour is off.

</details>

---

## Speed

Measured on a 154k-node file with a View seat:

| Call | Time |
| --- | --- |
| Anything captured in the last 12h | instant (cache) |
| Node on a page recorded in the last 30 min, incl. `figma_get_nodes` batches | ~3-5s, no browser |
| First node of a page, or an older recording | ~15s (~6s on a small file): ~10s for Figma to send the page, then decoded locally |
| `figma_get_image` / `figma_compare` without a PNG yet (live capture) | ~25-35s: the copy waits ~13s more for Figma to load the page |
| `figma_get_metadata` / `figma_search` on a new page | ~12s |
| `figma_compare` | ~4s; ~15s for a 3442×1740 frame at 2x |

Image URLs come from Figma's own `image/batch` endpoint with the browser session (no token, no quota); a node whose images still cannot be resolved is captured live.

---

## Reliability and safety

- **Several sessions at once:** captures are serialized across every refigma process on the machine
  (`~/.figma-local/capture.lock`); each capture works in a tab of its own and closes it; renders use a random port.
- **No stale code:** captures expire after 12h, and outputs record the extractor version — after an update of
  `lib/extract.py`, a cached capture is re-generated from its `msg.json.gz` in seconds instead of serving old code.
- **Nothing hangs:** every browser call has a timeout; a lost connection, a signal or an error ends the capture with
  a clear message and closes its tab; a killed render never leaves Edge running.
- **Design content is untrusted:** node ids are validated (they become paths) and links must be figma.com; layer names,
  links and font names are escaped in HTML, CSS and TSX; image downloads are pinned to Figma's hosts; the generated
  component is only transpiled in Node and rendered in the sandboxed browser.

---

## Updating

**Automatic since v0.6.0** — nothing to change in the MCP config. At each start the server checks the
[latest release](https://github.com/haonguyenstech/refigma-mcp/releases/latest) in the background (at most every 6h),
installs it into `~/.figma-local/app/<version>/`, and runs it from the **next** start: restart Claude Desktop, or
`/mcp` → `refigma-mcp` → **Reconnect** in Claude Code. `figma_status` shows the running version and a downloaded one
waiting for a restart; `~/.figma-local/app/update.log` records each install.

| Variable | Effect |
| --- | --- |
| `REFIGMA_AUTO_UPDATE=0` | Off: run exactly the version in the config URL. |
| `REFIGMA_UPDATE_EVERY` | Seconds between checks (default `21600`). |

Check now: `node ~/.figma-local/app/<version>/lib/update.mjs --force` (or the `lib/update.mjs` of your install).
Roll back: set `REFIGMA_AUTO_UPDATE=0` and an older release's URL, or delete the newer folder under `~/.figma-local/app/`.

**From v0.5.0 or older, or v0.6.0 on Windows** (no working updater there): switch the URL once, then updates are automatic.

```bash
claude mcp remove refigma-mcp -s user
claude mcp add -s user refigma-mcp -- npx -y https://github.com/haonguyenstech/refigma-mcp/releases/download/v0.6.2/refigma-mcp-0.6.2.tgz
```

Cached captures are re-generated automatically when a release changes the extractor.

### Updating in Claude Desktop

**Which version is running?** In a chat, ask *"run figma_status"*. Its first line is the version, e.g.
`refigma-mcp v0.6.0`, plus `(v0.7.0 is installed: restart the MCP server to use it)` when a newer release is waiting.

**On v0.6.0 or newer (v0.6.1 on Windows) — nothing to edit.** New releases download by themselves in the background; to start using one:

1. **Quit** Claude Desktop completely (⌘Q on macOS; on Windows, quit from the tray icon) and open it again.
   Closing the window does not restart the server.
2. Ask *"run figma_status"* again: the first line shows the new version.

To take a release right away instead of waiting for the next check (up to 6h), run this once in a terminal, then
quit and reopen Claude Desktop:

```bash
# macOS / Linux — any installed copy's updater fetches the latest release
node "$(find ~/.figma-local/app ~/.npm/_npx -path '*lib/update.mjs' 2>/dev/null | head -1)" --force
tail -1 ~/.figma-local/app/update.log      # "installed 0.7.0 (was 0.6.0); used from the next start"
```

```powershell
# Windows
# the updater of the newest installed copy (v0.6.0's cannot install on Windows)
$u = Get-ChildItem "$env:USERPROFILE\.figma-local\app", "$env:LOCALAPPDATA\npm-cache\_npx" -Recurse -Filter update.mjs -ErrorAction SilentlyContinue |
  Where-Object FullName -like '*lib\update.mjs' |
  Sort-Object { [version](Get-Content "$($_.Directory.Parent.FullName)\package.json" -Raw | ConvertFrom-Json).version } -Descending | Select-Object -First 1
node $u.FullName --force
Get-Content "$env:USERPROFILE\.figma-local\app\update.log" -Tail 1
```

The last line says `installed …` or `up to date: …`.

**On v0.5.0 or older (or v0.6.0 on Windows) — change the URL once.** Those versions have no working updater, and each release URL is cached by
`npx`, so they never move on their own:

1. **Settings → Developer → Edit Config** opens `claude_desktop_config.json`
   (macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`).
   With an organization gateway the app reads `Claude-3p/claude_desktop_config.json` in the same folder instead.
2. In the `refigma-mcp` entry, set the release URL in `args`; keep `command` and `env` as they are:

   ```json
   "args": ["-y", "https://github.com/haonguyenstech/refigma-mcp/releases/download/v0.6.2/refigma-mcp-0.6.2.tgz"]
   ```

3. Quit Claude Desktop completely and open it again, then check with *"run figma_status"*.
   From here on, updates follow the steps above with no config change.

A connector your organization manages (**Settings → Connectors**, marked *Managed*) is changed by its admin, not by you.

**If the version does not change** although the [latest release](https://github.com/haonguyenstech/refigma-mcp/releases/latest) is newer — read `~/.figma-local/app/update.log` (written only when an install succeeds or fails):

| Log line | Fix |
| --- | --- |
| no file, or no line about the new release | The server never ran an update check: `REFIGMA_AUTO_UPDATE` is `0` in `env`, or the server runs from a local checkout (`node …/server.mjs`), which never updates itself — use `git pull` there. |
| `npm install: …` / `spawn npm ENOENT` | npm is not found next to the `node` Claude Desktop runs: put that folder first in `env.PATH` (see *If it does not show up* above). |
| `releases/latest 403` | GitHub's API limit for your IP (60 requests/h); the next check retries. |

**Roll back:** add `"REFIGMA_AUTO_UPDATE": "0"` to `env` and put the older release's URL in `args`, then restart.

---

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `REFIGMA_CACHE_MAX_AGE` | `43200` (12h) | Seconds a node capture is reused before it is taken again. |
| `REFIGMA_DOC_MAX_AGE` | `1800` | Seconds a recorded page document may serve node data. |
| `REFIGMA_SOURCE=clipboard` | — | Always capture live, never from a recorded document. |
| `REFIGMA_PROTO=1` | — | Experimental: try the prototype viewer first (just the frame, ~1MB; 10-25s; misses images the browser already cached). |
| `REFIGMA_LOAD_TIMEOUT` | `150` | Seconds a capture waits for the editor and the page document. |
| `REFIGMA_PORT` | `9334` | CDP port of the headless capture browser. |
| `REFIGMA_CDP` | — | Capture in another browser, e.g. `9222` to watch it in a visible debug Edge. |
| `REFIGMA_BROWSER` | Microsoft Edge | Browser executable for capture and rendering. |
| `REFIGMA_EDGE_PROFILE` | `~/Library/Application Support/Microsoft Edge/Default` | macOS: profile the figma.com session is copied from. |
| `REFIGMA_PYTHON` | `python3`; Windows: `python`, then `py -3` | Python 3 interpreter. |
| `REFIGMA_LOGIN_TIMEOUT` | `300` | Windows: seconds `figma_relogin` waits for the sign-in. |
| `FIGMA_API_KEY` / `FIGMA_ACCESS_TOKEN` | — | Last fallback for images `image/batch` did not resolve (REST image-fills, Tier 2 quota; cached per file for 12h). Rarely needed. |
| `REFIGMA_TRACE=1` | — | Timing trace of a capture on stderr. |

**Cache** — `~/.figma-local/out/<file key>/`:

```text
<node id>/       tree.txt  index.html  <Component>.tsx  assets/  tokens.json  frame.png  msg.json.gz
_doc/<page id>/  recorded page document (schema + frames, outline, image URLs)
_images/         images shared by every node of the file
```

Deleting any of it is safe: it is captured again on the next call.

---

## Development

Run from a checkout instead of the published package:

```bash
git clone https://github.com/haonguyenstech/refigma-mcp && cd refigma-mcp && npm install
claude mcp add -s user refigma-mcp -- node "$PWD/server.mjs"
```

```text
server.mjs          MCP tools, cache, lock, source selection
lib/capture.mjs     drives the headless Edge: page document + copy data + PNG
lib/browser.mjs     the headless capture browser and its figma.com session (cookies.py decrypts Edge's cookies)
lib/doc.mjs         recorded page documents: ingest, outline, search, node extraction
lib/decode.mjs      Figma clipboard HTML → JSON message
lib/extract.py      message → model → tree.txt, HTML/CSS, React + Tailwind, SVG, tokens, images
lib/headless.mjs    throwaway sRGB render browser (compare, export)
lib/compare.mjs     render + pixel diff · lib/export.mjs  PNG / JPG / PDF · lib/render-tsx.mjs  React → page
```

**Check a change to `lib/extract.py` against every cached frame** — regenerating is cheap:

```bash
mkdir -p /tmp/out && python3 lib/extract.py <capture dir>/msg.json.gz <node id> /tmp/out > /tmp/out/extract.json
node lib/compare.mjs /tmp/out/index.html <capture dir>/frame.png <w> <h> /tmp/out/cmp   # w, h from extract.json
```

Run-to-run render noise is about ±0.001%. Accept a change only when no frame gets worse.

### Releasing

A release is a git tag plus the packed `.tgz` attached to its GitHub release — no npm account involved:

```bash
npm version 0.6.0 --no-git-tag-version          # bump package.json (the server reports this version)
git commit -am "v0.6.0" && git push
npm pack                                         # → refigma-mcp-0.6.0.tgz
gh release create v0.6.0 refigma-mcp-0.6.0.tgz --title "v0.6.0" --notes "…"
```

Installs from v0.6.0 on pick the release up by themselves (`lib/update.mjs` reads `releases/latest` and needs the
`refigma-mcp-*.tgz` asset). Put the install command with the new URL in the release notes for new users and those
on v0.5.0 or older, then update the URLs in this README.

---

## Limitations

- Relies on Figma's undocumented clipboard and multiplayer formats; a Figma release can break it.
- Figma loads pages lazily: `figma_search` covers the pages recorded so far; `figma_get_metadata` records a node's
  page on demand.
- Not rendered yet: grid auto layout (children keep their absolute positions), angular / diamond gradients inside SVG
  icons, corner smoothing (plain radius), vector masks in HTML (their box),
  boolean EXCLUDE (drawn like UNION). FigJam is started (`figjam_svg`) but not verified.
- Fonts missing from Google Fonts fall back to the browser's.
- A frame is static: no responsive behaviour; sizes are exact px, with hug / fill recorded in the tree.
- **Security:** the capture browser's CDP port (`:9334`) has no authentication and holds a signed-in figma.com
  session, so any local process can drive it.

---

## Credits

- [kiwi-schema](https://github.com/evanw/kiwi), [pixelmatch](https://github.com/mapbox/pixelmatch), [esbuild](https://esbuild.github.io), the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- Example frame in the screenshots: [Bitcoin Design](https://bitcoin.design) UI Kit, CC BY 4.0

<div align="center"><sub>MIT License · Not affiliated with Figma.</sub></div>
