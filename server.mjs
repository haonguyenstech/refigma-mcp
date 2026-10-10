#!/usr/bin/env node
// refigma-mcp: read Figma frames by copying the node in a logged-in debug Edge (CDP :9222) and decoding
// Figma's clipboard binary locally — no REST API quota, no plugin, works on View seats.
// Each capture yields tree.txt, index.html (pixel-faithful HTML/CSS), assets/icons/*.svg, assets/images/*, tokens.json.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const READER = path.join(ROOT, 'bin', 'figma-read');
const CACHE = path.join(os.homedir(), '.figma-local', 'out');
const ENV = { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` };

function parseUrl(url) {
  const u = new URL(url);
  const file = u.pathname.match(/\/(?:design|file|proto)\/([A-Za-z0-9]+)/)?.[1];
  const node = u.searchParams.get('node-id')?.replace('-', ':');
  if (!file || !node) throw new Error('URL must be a figma.com/design link with ?node-id= (right-click a frame → Copy link to selection)');
  return { file, node, dir: path.join(CACHE, file, node.replace(':', '-')) };
}

const run = (cmd, args, timeout = 240_000) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout, env: ENV, maxBuffer: 64 << 20 }, (err, stdout, stderr) =>
    err ? reject(new Error((stderr || stdout || err.message).trim())) : resolve(stdout)));

// One debug browser, so captures must not overlap.
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn, fn));

// Everything goes through the queue so a cached read never sees a capture that is still being written.
const capture = (url, refresh) => serial(() => captureNow(url, refresh));

async function captureNow(url, refresh) {
  const t = parseUrl(url);
  const has = f => fs.existsSync(path.join(t.dir, f));
  if (!refresh && has('index.html') && has('extract.json')) return { ...t, cached: true };
  if (!refresh && has('msg.json')) {   // captured by an older version: re-extract without touching the browser
    fs.writeFileSync(path.join(t.dir, 'extract.json'), await run('python3', [path.join(ROOT, 'lib', 'extract.py'), path.join(t.dir, 'msg.json'), t.node, t.dir]));
    return { ...t, cached: true };
  }
  await run(READER, [url, t.dir]);
  return { ...t, cached: false };
}

const read = (r, f) => fs.readFileSync(path.join(r.dir, f), 'utf8');
const text = s => ({ content: [{ type: 'text', text: s }] });
const fail = e => ({ isError: true, content: [{ type: 'text', text: String(e.message || e) }] });
const URL_ARG = z.string().describe('figma.com/design/... link containing node-id');
const REFRESH = z.boolean().optional().describe('Re-capture instead of using the cache (use after the design changed)');

const server = new McpServer({ name: 'refigma-mcp', version: '0.2.0' });

server.registerTool('figma_get_node', {
  title: 'Read a Figma frame as a layout tree',
  description: 'Compact layout tree of the node: auto-layout (row/col, gap, padding, justify/align, hug/fixed, fill-main/fill-cross, wrap, absolute), size/position/rotation, fills (solid with token name, gradients as CSS, images), strokes (per side, align, dash), radius (per corner), shadows/blur with exact params, clip, typography (family, weight, size/line-height, letter-spacing, alignment, resize mode, mixed runs) and text. Instances are expanded with overrides, component properties and variable modes applied; vector groups point at their exported SVG. Start here, then use figma_get_html for exact CSS and figma_get_assets for icons/images.',
  inputSchema: { url: URL_ARG, refresh: REFRESH, max_lines: z.number().int().positive().optional().describe('Truncate (default 2000 lines)') },
}, async ({ url, refresh, max_lines = 2000 }) => {
  try {
    const r = await capture(url, refresh);
    const lines = read(r, 'tree.txt').split('\n');
    const body = lines.slice(0, max_lines).join('\n') + (lines.length > max_lines ? `\n… truncated (${lines.length} lines total)` : '');
    return text(`file=${r.file} node=${r.node} ${r.cached ? '(cached)' : '(fresh)'} dir=${r.dir}\nlegend: WxH @x,y [dir gap pad=T R B L justify align size=main/cross] fill-main/fill-cross=stretch, colors as #HEX(token)\n\n${body}`);
  } catch (e) { return fail(e); }
});

server.registerTool('figma_get_html', {
  title: 'Get pixel-faithful HTML/CSS for a Figma frame',
  description: 'Deterministic HTML + CSS generated straight from Figma data (flexbox for auto-layout, exact px sizes, outline strokes, box-shadows, gradients, inline SVG icons, token CSS variables with exact fallbacks, Google Fonts link). Verified against Figma\'s own render with figma_compare. Use it as the source of truth when implementing: translate its structure and values into the target framework instead of eyeballing the PNG. Returns the file path and (unless path_only) the HTML.',
  inputSchema: { url: URL_ARG, refresh: REFRESH, path_only: z.boolean().optional() },
}, async ({ url, refresh, path_only }) => {
  try {
    const r = await capture(url, refresh);
    const p = path.join(r.dir, 'index.html');
    return text(path_only ? p : `${p}\n\n${read(r, 'index.html')}`);
  } catch (e) { return fail(e); }
});

server.registerTool('figma_get_assets', {
  title: 'Export icons (SVG) and images of a Figma frame',
  description: 'Lists the SVG icons (built from Figma vector geometry, named after their components) and raster images used by the node. Pass dest to copy them into your project (e.g. src/assets/figma).',
  inputSchema: { url: URL_ARG, refresh: REFRESH, dest: z.string().optional().describe('Directory to copy icons/ and images/ into') },
}, async ({ url, refresh, dest }) => {
  try {
    const r = await capture(url, refresh);
    const list = sub => { const d = path.join(r.dir, 'assets', sub); return fs.existsSync(d) ? fs.readdirSync(d).map(f => path.join(d, f)) : []; };
    const icons = list('icons'), images = list('images');
    let note = '';
    if (dest) {
      for (const [sub, files] of [['icons', icons], ['images', images]]) {
        fs.mkdirSync(path.join(dest, sub), { recursive: true });
        for (const f of files) fs.copyFileSync(f, path.join(dest, sub, path.basename(f)));
      }
      note = `\ncopied to ${dest}/icons and ${dest}/images`;
    }
    return text(`icons (${icons.length}):\n${icons.join('\n')}\n\nimages (${images.length}):\n${images.join('\n')}${note}`);
  } catch (e) { return fail(e); }
});

server.registerTool('figma_get_tokens', {
  title: 'Design tokens used by a Figma frame',
  description: 'Every Figma variable referenced by the node: CSS variable name, the value as rendered in this frame, and its values per mode (e.g. light/dark) — ready for a CSS :root block or a Tailwind theme.',
  inputSchema: { url: URL_ARG, refresh: REFRESH },
}, async ({ url, refresh }) => {
  try {
    const r = await capture(url, refresh);
    const tokens = JSON.parse(read(r, 'tokens.json'));
    const rows = Object.entries(tokens).map(([name, t]) =>
      `${t.css}: ${t.painted ?? Object.values(t.values)[0] ?? ''}   /* ${name}${Object.keys(t.values).length > 1 ? ' | modes ' + JSON.stringify(t.values) : ''} */`);
    const fonts = [...new Set([...read(r, 'tree.txt').matchAll(/font=([^"]+?) (?=ls=|text-align|v-align|resize=)/g)].map(m => m[1]))].sort();
    return text(`/* ${rows.length} tokens */\n${rows.join('\n')}\n\n/* text styles */\n${fonts.join('\n')}`);
  } catch (e) { return fail(e); }
});

server.registerTool('figma_get_image', {
  title: 'Render a Figma frame as PNG',
  description: "Figma's own 1x PNG of the node (\"Copy as PNG\"). Visual reference; figma_compare diffs against it.",
  inputSchema: { url: URL_ARG, refresh: REFRESH },
}, async ({ url, refresh }) => {
  try {
    const r = await capture(url, refresh);
    const png = path.join(r.dir, 'frame.png');
    if (!fs.existsSync(png)) return fail(new Error('PNG was not captured (the debug Edge window must be visible); retry with refresh=true'));
    return { content: [{ type: 'image', data: fs.readFileSync(png).toString('base64'), mimeType: 'image/png' }, { type: 'text', text: png }] };
  } catch (e) { return fail(e); }
});

server.registerTool('figma_compare', {
  title: 'Pixel-diff an implementation against the Figma frame',
  description: "Renders target (a URL such as http://localhost:5173/page, or an HTML file; default: the generated index.html) at the frame's exact size in an sRGB headless Edge and diffs it with Figma's PNG. Returns match %, the worst regions, and the diff image (red = mismatch). Iterate on your implementation until the match is ~99.9%.",
  inputSchema: { url: URL_ARG, target: z.string().optional(), refresh: REFRESH },
}, async ({ url, target, refresh }) => {
  try {
    const r = await capture(url, refresh);
    const png = path.join(r.dir, 'frame.png');
    if (!fs.existsSync(png)) return fail(new Error('No Figma PNG to compare against; run figma_get_image with refresh=true while the debug Edge window is visible'));
    const { w, h } = JSON.parse(read(r, 'extract.json'));
    const out = path.join(r.dir, 'compare', target ? 'target' : 'generated');
    const res = JSON.parse(await run('node', [path.join(ROOT, 'lib', 'compare.mjs'), target || path.join(r.dir, 'index.html'), png, String(w), String(h), out], 180_000));
    const regions = res.worstRegions.map(c => `  x=${c.x} y=${c.y} ${c.w}x${c.h}: ${c.pct}% differs`).join('\n');
    return { content: [
      { type: 'text', text: `match ${res.match}% (${res.diffPixels} px differ of ${w * h})\nworst regions:\n${regions || '  none'}\nrender: ${res.render}\ndiff: ${res.diff}` },
      { type: 'image', data: fs.readFileSync(res.diff).toString('base64'), mimeType: 'image/png' },
    ] };
  } catch (e) { return fail(e); }
});

server.registerTool('figma_status', {
  title: 'Check refigma prerequisites',
  description: 'Checks that the debug Edge is up on CDP :9222 and lists cached captures.',
  inputSchema: {},
}, async () => {
  const cached = fs.existsSync(CACHE) ? fs.readdirSync(CACHE).flatMap(f => fs.readdirSync(path.join(CACHE, f)).map(n => `${f} ${n.replace('-', ':')}`)) : [];
  try {
    const v = await (await fetch('http://127.0.0.1:9222/json/version')).json();
    const tabs = await (await fetch('http://127.0.0.1:9222/json')).json();
    const fig = tabs.filter(t => t.type === 'page' && t.url.includes('figma.com'));
    return text(`debug browser: ${v.Browser}, figma tabs: ${fig.length}\ncached captures (${cached.length}):\n${cached.join('\n')}\nIf a capture fails with "editor did not load", re-import figma.com cookies into the debug Edge (import-cookie skill).`);
  } catch {
    return text(`debug Edge is not running on :9222 — it is launched automatically on the next capture.\ncached captures (${cached.length}):\n${cached.join('\n')}`);
  }
});

await server.connect(new StdioServerTransport());
