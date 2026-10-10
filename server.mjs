#!/usr/bin/env node
// refigma-mcp: read Figma design files through a private headless Edge (no window, no Figma Desktop) — no REST quota, no plugin,
// works on View seats. A capture records the page document (multiplayer stream) and copies the node; everything
// is decoded locally into tree.txt, index.html, <Component>.tsx, assets/, tokens.json (+ Figma's PNG).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LIB = f => path.join(ROOT, 'lib', f);
const READER = path.join(ROOT, 'bin', 'figma-read');
const CACHE = path.join(os.homedir(), '.figma-local', 'out');
const ENV = { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` };

function parseUrl(url, nodeOverride) {
  const u = new URL(url);
  const file = u.pathname.match(/\/(?:design|file|proto)\/([A-Za-z0-9]+)/)?.[1];
  if (!file) throw new Error('Expected a figma.com/design/<fileKey>/... link');
  const node = (nodeOverride || u.searchParams.get('node-id') || '').replace('-', ':') || null;
  const fdir = path.join(CACHE, file);
  return { file, node, fdir, dir: node ? path.join(fdir, node.replace(':', '-')) : null,
    nodeUrl: node ? `${u.origin}/design/${file}/x?node-id=${node.replace(':', '-')}` : `${u.origin}/design/${file}/x` };
}

const run = (cmd, args, timeout = 240_000) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout, env: ENV, maxBuffer: 64 << 20 }, (err, stdout, stderr) =>
    err ? reject(new Error((stderr || stdout || err.message).trim())) : resolve(stdout)));

// One debug browser: every capture/read goes through one queue so nothing reads a half-written capture.
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn, fn));
const has = (dir, f) => fs.existsSync(path.join(dir, f));
const hasDoc = fdir => has(fdir, 'pages.json');

async function extractFromMsg(t) {
  fs.writeFileSync(path.join(t.dir, 'extract.json'), await run('python3', [LIB('extract.py'), path.join(t.dir, 'msg.json'), t.node, t.dir]));
}

// Full capture of the node (clipboard data + Figma PNG). `fast` uses the recorded page document instead when possible.
const capture = (url, refresh, opts = {}) => serial(async () => {
  const t = parseUrl(url, opts.node);
  if (!t.node) throw new Error('This tool needs a node: pass a link with ?node-id= (right-click a frame → Copy link to selection) or node_id');
  if (!refresh && has(t.dir, 'index.html') && has(t.dir, 'extract.json')) return { ...t, cached: true };
  if (!refresh && has(t.dir, 'msg.json')) { await extractFromMsg(t); return { ...t, cached: true }; }
  if (opts.fast && hasDoc(t.fdir)) {
    try {
      fs.mkdirSync(t.dir, { recursive: true });
      await run('node', [LIB('doc.mjs'), 'extract', t.fdir, t.node, path.join(t.dir, 'msg.json'), t.file]);
      await extractFromMsg(t);
      return { ...t, cached: false, source: 'document' };
    } catch { /* not on a recorded page: fall through to a live capture */ }
  }
  await run(READER, [t.nodeUrl, t.dir]);
  return { ...t, cached: false, source: 'clipboard' };
});

const ensureDoc = (url, refresh) => serial(async () => {
  const t = parseUrl(url);
  if (refresh || !hasDoc(t.fdir)) {
    await run('node', [LIB('capture.mjs'), t.nodeUrl, path.join(t.fdir, '_doc', '_new')]);
    await run('node', [LIB('doc.mjs'), 'ingest', t.fdir]);
  }
  return t;
});

const read = (r, f) => fs.readFileSync(path.join(r.dir, f), 'utf8');
const text = s => ({ content: [{ type: 'text', text: s }] });
const fail = e => ({ isError: true, content: [{ type: 'text', text: String(e.message || e) }] });
const URL_ARG = z.string().describe('figma.com/design/... link (with ?node-id= for node tools)');
const NODE_ARG = z.string().optional().describe('Node id like "3685:53706" — overrides the node-id in the link');
const REFRESH = z.boolean().optional().describe('Re-capture instead of using the cache (use after the design changed)');
const componentFile = r => JSON.parse(read(r, 'extract.json')).component;

const server = new McpServer({ name: 'refigma-mcp', version: '0.3.0' });

server.registerTool('figma_get_metadata', {
  title: 'Outline of a Figma file / node',
  description: 'Without a node: lists every page of the file and the sections/frames of the recorded page(s) as sparse XML (id, name, type, x, y, width, height). With a node: the outline under it to `depth`. Use it to discover frame ids, then call the other tools with node_id. Pages load lazily in Figma: to outline another page, pass a link whose node-id is on that page with refresh=true.',
  inputSchema: { url: URL_ARG, node_id: NODE_ARG, depth: z.number().int().positive().optional(), refresh: REFRESH },
}, async ({ url, node_id, depth, refresh }) => {
  try {
    const t = await ensureDoc(url, refresh);
    const node = (node_id || '').replace('-', ':');
    const pages = node ? '' : await run('node', [LIB('doc.mjs'), 'pages', t.fdir]);
    const outline = await run('node', [LIB('doc.mjs'), 'outline', t.fdir, node, String(depth || (node ? 3 : 2))]);
    return text(`${pages ? `<pages>\n${pages}</pages>\n\n` : ''}${outline}`);
  } catch (e) { return fail(e); }
});

server.registerTool('figma_search', {
  title: 'Find layers by name',
  description: 'Case-insensitive name search across the recorded page(s) of the file. Returns id, type, name, size and the path of each match.',
  inputSchema: { url: URL_ARG, query: z.string(), limit: z.number().int().positive().optional(), refresh: REFRESH },
}, async ({ url, query, limit, refresh }) => {
  try {
    const t = await ensureDoc(url, refresh);
    return text(await run('node', [LIB('doc.mjs'), 'search', t.fdir, query, String(limit || 50)]) || 'no matches');
  } catch (e) { return fail(e); }
});

server.registerTool('figma_get_node', {
  title: 'Read a Figma node as a layout tree',
  description: 'Compact layout tree: auto-layout (dir, gap, padding, justify/align, hug/fixed, fill-main/fill-cross, wrap, absolute), size/position/rotation, fills (solid #HEX(token), gradients, images), strokes (per side, align, dash), radius per corner, shadow/blur params, clip, typography (family, weight, size/line-height, letter-spacing, alignment, resize, mixed runs), text, style names (text/fill/effect styles), prototype interactions (on:click/hover → target, transition), hover variants, Dev Mode annotations. Instances are expanded with overrides, component properties, variant swaps and variable modes applied. Start here; use figma_get_code for exact code.',
  inputSchema: { url: URL_ARG, node_id: NODE_ARG, refresh: REFRESH, max_lines: z.number().int().positive().optional().describe('Truncate (default 2000 lines)') },
}, async ({ url, node_id, refresh, max_lines = 2000 }) => {
  try {
    const r = await capture(url, refresh, { node: node_id });
    const lines = read(r, 'tree.txt').split('\n');
    const body = lines.slice(0, max_lines).join('\n') + (lines.length > max_lines ? `\n… truncated (${lines.length} lines total)` : '');
    return text(`file=${r.file} node=${r.node} ${r.cached ? '(cached)' : `(fresh, ${r.source})`} dir=${r.dir}\nlegend: WxH @x,y [dir gap pad=T R B L justify align size=main/cross] fill-main/fill-cross=stretch, colors #HEX(token), style{...}=Figma style names, on:event→action(target transition)\n\n${body}`);
  } catch (e) { return fail(e); }
});

server.registerTool('figma_get_nodes', {
  title: 'Read several nodes at once',
  description: 'Layout trees for several node ids of the same file. Nodes on an already-recorded page are extracted from the page document in seconds (no browser round-trip); others are captured live.',
  inputSchema: { url: URL_ARG, node_ids: z.array(z.string()).min(1), max_lines_each: z.number().int().positive().optional() },
}, async ({ url, node_ids, max_lines_each = 400 }) => {
  try {
    const parts = [];
    for (const id of node_ids) {
      try {
        const r = await capture(url, false, { node: id, fast: true });
        const lines = read(r, 'tree.txt').split('\n');
        parts.push(`### node ${r.node} (${r.cached ? 'cached' : r.source})\n` + lines.slice(0, max_lines_each).join('\n') + (lines.length > max_lines_each ? `\n… truncated (${lines.length} lines)` : ''));
      } catch (e) { parts.push(`### node ${id}\nERROR: ${e.message}`); }
    }
    return text(parts.join('\n\n'));
  } catch (e) { return fail(e); }
});

server.registerTool('figma_get_code', {
  title: 'Pixel-faithful code for a Figma node',
  description: 'Deterministic code generated straight from Figma data and verified against Figma\'s own render (~99.97% pixel match): format "html" = HTML + CSS (flexbox, exact px, outline strokes, shadows, gradients, inline SVG icons, token CSS variables, :hover rules + transitions from prototype hover variants, data-on-click targets); format "react" = a React component with Tailwind arbitrary values (same values; hover via group-hover). Translate it into the project\'s conventions rather than eyeballing the PNG.',
  inputSchema: { url: URL_ARG, node_id: NODE_ARG, format: z.enum(['html', 'react']).optional(), refresh: REFRESH, path_only: z.boolean().optional() },
}, async ({ url, node_id, format = 'html', refresh, path_only }) => {
  try {
    const r = await capture(url, refresh, { node: node_id });
    const f = format === 'react' ? componentFile(r) : 'index.html';
    const p = path.join(r.dir, f);
    return text(path_only ? p : `${p}\n\n${read(r, f)}`);
  } catch (e) { return fail(e); }
});

server.registerTool('figma_get_assets', {
  title: 'Export icons (SVG) and images of a Figma node',
  description: 'SVG icons built from Figma vector geometry (named after their components) and original raster images used by the node. Pass dest to copy them into your project (e.g. src/assets/figma).',
  inputSchema: { url: URL_ARG, node_id: NODE_ARG, refresh: REFRESH, dest: z.string().optional() },
}, async ({ url, node_id, refresh, dest }) => {
  try {
    const r = await capture(url, refresh, { node: node_id });
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

server.registerTool('figma_export', {
  title: 'Export a node as PNG / JPG / PDF',
  description: 'Exports a node of a captured frame at any scale (1x/2x/3x…) as PNG (transparent), JPG or vector PDF, rendered from the verified HTML in an sRGB headless Edge. node_id defaults to the captured frame itself; any id inside it (from figma_get_node / figma_get_metadata) works.',
  inputSchema: { url: URL_ARG, node_id: NODE_ARG, format: z.enum(['png', 'jpg', 'pdf']).optional(), scale: z.number().positive().max(4).optional(), dest: z.string().optional().describe('Output file path') },
}, async ({ url, node_id, format = 'png', scale = 2, dest }) => {
  try {
    const t = parseUrl(url);
    // export from the frame capture that contains the node; fall back to capturing the node itself
    let r = t.node && has(t.dir || '', 'index.html') ? { ...t } : await capture(url, false, { node: node_id, fast: true });
    const id = (node_id || r.node).replace('-', ':');
    if (!fs.readFileSync(path.join(r.dir, 'index.html'), 'utf8').includes(`data-id="${id}"`)) r = await capture(url, false, { node: id, fast: true });
    const out = dest || path.join(r.dir, 'exports', `${id.replace(':', '-')}@${scale}x.${format}`);
    const res = JSON.parse(await run('node', [LIB('export.mjs'), r.dir, id === r.node ? 'root' : id, format, String(scale), out], 180_000));
    const content = [{ type: 'text', text: `${res.out} (${res.width}x${res.height}, ${format} @${scale}x)` }];
    if (format === 'png' && res.width * res.height < 9e6) content.push({ type: 'image', data: fs.readFileSync(res.out).toString('base64'), mimeType: 'image/png' });
    return { content };
  } catch (e) { return fail(e); }
});

server.registerTool('figma_get_tokens', {
  title: 'Design tokens and styles used by a Figma node',
  description: 'Figma variables referenced by the node (CSS variable name, value as rendered, values per mode) plus the named text / fill / effect styles it uses with their values — ready for a CSS :root block, a Tailwind theme or a typography scale.',
  inputSchema: { url: URL_ARG, node_id: NODE_ARG, refresh: REFRESH },
}, async ({ url, node_id, refresh }) => {
  try {
    const r = await capture(url, refresh, { node: node_id });
    const tokens = JSON.parse(read(r, 'tokens.json'));
    const rows = Object.entries(tokens).map(([name, t]) =>
      `${t.css}: ${t.painted ?? Object.values(t.values)[0] ?? ''};   /* ${name}${Object.keys(t.values).length > 1 ? ' | modes ' + JSON.stringify(t.values) : ''} */`);
    const styles = new Map();
    const walk = m => {
      for (const [kind, name] of Object.entries(m.styles || {})) {
        let val = '';
        if (kind === 'text' && m.text) { const t = m.text; val = `${t.family} ${t.weight} ${t.size}px/${t.lineHeight?.units === 'PIXELS' ? t.lineHeight.value + 'px' : 'normal'}${t.letterSpacing?.value ? ` ls ${t.letterSpacing.value}${t.letterSpacing.units === 'PERCENT' ? '%' : 'px'}` : ''}`; }
        if (kind === 'effect') val = (m.effects || []).map(e => e.type === 'drop' || e.type === 'inner' ? `${e.type === 'inner' ? 'inset ' : ''}${e.x}px ${e.y}px ${e.blur}px ${e.spread}px ${e.color}` : `${e.type} ${e.radius}`).join(', ');
        if (kind === 'fill') val = (m.fills || []).map(f => f.color || f.css || f.type).join(', ');
        if (kind === 'stroke') val = (m.stroke?.paints || []).map(f => f.color || f.css).join(', ');
        if (!styles.has(`${kind}:${name}`)) styles.set(`${kind}:${name}`, `${kind.padEnd(6)} "${name}"  ${val}`);
      }
      for (const c of m.children || []) walk(c);
    };
    walk(JSON.parse(read(r, 'model.json')));
    return text(`/* ${rows.length} variables */\n${rows.join('\n')}\n\n/* ${styles.size} styles */\n${[...styles.values()].sort().join('\n')}`);
  } catch (e) { return fail(e); }
});

server.registerTool('figma_get_image', {
  title: "Figma's own render of a node",
  description: "Figma's 1x PNG of the node (\"Copy as PNG\"). It is the ground truth figma_compare diffs against. For other scales/formats use figma_export.",
  inputSchema: { url: URL_ARG, node_id: NODE_ARG, refresh: REFRESH },
}, async ({ url, node_id, refresh }) => {
  try {
    const r = await capture(url, refresh, { node: node_id });
    const png = path.join(r.dir, 'frame.png');
    if (!fs.existsSync(png)) return fail(new Error('Figma PNG not captured (node was extracted from the page document). Retry with refresh=true, or use figma_export.'));
    return { content: [{ type: 'image', data: fs.readFileSync(png).toString('base64'), mimeType: 'image/png' }, { type: 'text', text: png }] };
  } catch (e) { return fail(e); }
});

server.registerTool('figma_compare', {
  title: 'Pixel-diff an implementation against the Figma node',
  description: "Renders target (a URL such as http://localhost:5173/page, an HTML file, or \"react\" for the generated component; default: the generated HTML) at the node's size in an sRGB headless Edge and diffs it with Figma's PNG. Returns match %, worst regions and the diff image (red = mismatch). Iterate until ~99.9%.",
  inputSchema: { url: URL_ARG, node_id: NODE_ARG, target: z.string().optional(), refresh: REFRESH },
}, async ({ url, node_id, target, refresh }) => {
  try {
    const r = await capture(url, refresh, { node: node_id });
    const png = path.join(r.dir, 'frame.png');
    if (!fs.existsSync(png)) return fail(new Error('No Figma PNG to compare against; run figma_get_image with refresh=true'));
    const { w, h } = JSON.parse(read(r, 'extract.json'));
    let file = target || path.join(r.dir, 'index.html');
    const env = { ...ENV };
    if (target === 'react') {
      file = path.join(r.dir, 'react.html');
      await run('node', [LIB('render-tsx.mjs'), path.join(r.dir, componentFile(r)), file]);
      env.SETTLE_MS = '2500';   // Tailwind Play CDN compiles classes after load
    }
    const out = path.join(r.dir, 'compare', target ? (target === 'react' ? 'react' : 'target') : 'generated');
    const res = await new Promise((resolve, reject) => execFile('node', [LIB('compare.mjs'), file, png, String(w), String(h), out],
      { timeout: 300_000, env, maxBuffer: 64 << 20 }, (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).trim())) : resolve(JSON.parse(stdout))));
    const regions = res.worstRegions.map(c => `  x=${c.x} y=${c.y} ${c.w}x${c.h}: ${c.pct}% differs`).join('\n');
    return { content: [
      { type: 'text', text: `match ${res.match}% (${res.diffPixels} px differ)\nworst regions:\n${regions || '  none'}\nrender: ${res.render}\ndiff: ${res.diff}` },
      { type: 'image', data: fs.readFileSync(res.diff).toString('base64'), mimeType: 'image/png' },
    ] };
  } catch (e) { return fail(e); }
});

server.registerTool('figma_relogin', {
  title: 'Refresh the figma.com session',
  description: "Copies the figma.com cookies from the user's real Microsoft Edge profile into refigma's headless browser and verifies the session. macOS may show a Keychain prompt (\"Microsoft Edge Safe Storage\") that the user must Allow. Use when a capture reports NOT_LOGGED_IN / editor did not load.",
  inputSchema: {},
}, async () => {
  try { return text(await run('node', [LIB('browser.mjs'), 'relogin'], 120_000)); } catch (e) { return fail(e); }
});

server.registerTool('figma_status', {
  title: 'Check refigma prerequisites',
  description: 'Headless browser state, recorded documents and cached captures.',
  inputSchema: {},
}, async () => {
  const files = fs.existsSync(CACHE) ? fs.readdirSync(CACHE) : [];
  const lines = files.map(f => {
    const nodes = fs.readdirSync(path.join(CACHE, f)).filter(n => /^\d+-\d+$/.test(n)).map(n => n.replace('-', ':'));
    return `${f}: document ${hasDoc(path.join(CACHE, f)) ? 'recorded' : 'no'}, captured nodes: ${nodes.join(', ') || 'none'}`;
  });
  let browser = 'headless browser not running (starts automatically on the next capture)';
  try { const v = await (await fetch('http://127.0.0.1:9334/json/version')).json(); browser = `headless browser: ${v.Browser} on :9334`; } catch {}
  return text(`${browser}\n${lines.join('\n') || 'no captures yet'}\nIf captures fail with NOT_LOGGED_IN, run figma_relogin.`);
});

await server.connect(new StdioServerTransport());
