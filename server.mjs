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
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LIB = f => path.join(ROOT, 'lib', f);
const READER = path.join(ROOT, 'bin', 'figma-read');
const CACHE = path.join(os.homedir(), '.figma-local', 'out');
// A bigger young generation roughly halves decoding time of a page snapshot (150k nodes) — GC dominated otherwise.
const ENV = { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-semi-space-size=64`.trim(),
  // node data comes from a recorded page document only while it is recent; older ones fall back to a live capture
  REFIGMA_DOC_MAX_AGE: process.env.REFIGMA_DOC_MAX_AGE || '1800' };

// "16140-105700" / "16140:105700" / instance "I123-45;67-89" -> "I123:45;67:89"; anything else is rejected (it becomes a path)
const NODE_ID = /^I?\d+:\d+(;\d+:\d+)*$/;
function normNode(id) {
  if (!id) return null;
  const n = String(id).trim().replaceAll('-', ':');
  if (!NODE_ID.test(n)) throw new Error(`Invalid node id "${id}" (expected e.g. 3685:53706)`);
  return n;
}
const nodeDir = node => node.replaceAll(':', '-');

function parseUrl(url, nodeOverride) {
  const u = new URL(url);
  if (!/^(www\.)?figma\.com$/.test(u.hostname)) throw new Error('Expected a figma.com link');
  // a branch link is /design/<main key>/branch/<branch key>/...: the branch is its own file
  const m = u.pathname.match(/\/(?:design|file|proto)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/);
  if (!m) throw new Error('Expected a figma.com/design/<fileKey>/... link');
  const file = m[2] || m[1];
  const base = `https://www.figma.com/design/${m[1]}${m[2] ? `/branch/${m[2]}` : ''}/x`;
  const node = normNode(nodeOverride || u.searchParams.get('node-id'));
  const fdir = path.join(CACHE, file);
  return { file, node, fdir, dir: node ? path.join(fdir, nodeDir(node)) : null,
    protoUrl: node ? `${base.replace('/design/', '/proto/')}?node-id=${nodeDir(node)}` : null,
    nodeUrl: node ? `${base}?node-id=${nodeDir(node)}` : base };
}

// A capture is reused for REFIGMA_CACHE_MAX_AGE seconds (default 12h), then taken again; every answer states its age.
const CACHE_MAX_AGE = +(process.env.REFIGMA_CACHE_MAX_AGE || 43200) * 1000;
const capturedAt = dir => { for (const f of ['msg.json', 'msg.json.gz', 'index.html']) try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch {} return 0; };
const ago = ms => { const s = Math.round((Date.now() - ms) / 1000);
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
const sourceNote = r => r.cached ? `cached, captured ${ago(capturedAt(r.dir))} ago — pass refresh=true if the design changed since` : `fresh, ${r.source}`;

const run = (cmd, args, timeout = 240_000) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout, env: ENV, maxBuffer: 64 << 20 }, (err, stdout, stderr) =>
    err ? reject(new Error((stderr || stdout || err.message).trim())) : resolve(stdout)));

// One debug browser: every capture/read goes through one queue so nothing reads a half-written capture.
// The queue orders this process; the lock file orders every refigma process on the machine (several Claude sessions
// share one headless browser and one cache).
const LOCK = path.join(os.homedir(), '.figma-local', 'capture.lock');
async function withLock(fn) {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  for (const start = Date.now(); ;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    let pid = 0, age = 0;
    try { pid = +fs.readFileSync(LOCK, 'utf8'); age = Date.now() - fs.statSync(LOCK).mtimeMs; } catch { continue; }   // released meanwhile
    let alive = false; try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    if (!alive || age > 600_000) { try { fs.unlinkSync(LOCK); } catch {} continue; }   // holder died, or hung for 10 min
    if (Date.now() - start > 300_000) throw new Error(`another refigma session (pid ${pid}) has held the capture lock for 5 minutes`);
    await new Promise(r => setTimeout(r, 300));
  }
  try { return await fn(); }
  finally { try { if (+fs.readFileSync(LOCK, 'utf8') === process.pid) fs.unlinkSync(LOCK); } catch {} }
}
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(() => withLock(fn), () => withLock(fn)));
const has = (dir, f) => fs.existsSync(path.join(dir, f));
const hasDoc = fdir => has(fdir, 'pages.json');

// msg.json (the node + its dependencies, often 30-80MB) is kept gzipped (~20x smaller) once it has been extracted
const msgPath = dir => ['msg.json', 'msg.json.gz'].map(f => path.join(dir, f)).find(f => fs.existsSync(f)) || null;
function packMsg(dir) {
  const src = path.join(dir, 'msg.json');
  if (!fs.existsSync(src)) return;
  const { mtime } = fs.statSync(src), gz = `${src}.gz`;
  fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(src)));
  fs.utimesSync(gz, mtime, mtime);   // keeps the capture time
  fs.rmSync(src);
}
const MSG_FILES = ['msg.json', 'msg.json.gz', 'extract.json', 'index.html'];

// Outputs record the extractor that made them: after an update of extract.py a cached capture is re-generated from its
// msg.json (seconds, no browser) instead of serving code from the old extractor.
const EXTRACTOR = crypto.createHash('sha1').update(fs.readFileSync(LIB('extract.py'))).digest('hex').slice(0, 12);
const stamp = dir => { const f = path.join(dir, 'extract.json');
  if (fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), extractor: EXTRACTOR })); };
const currentExtract = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'extract.json'), 'utf8')).extractor === EXTRACTOR; } catch { return false; } };

async function extractFromMsg(t) {
  fs.writeFileSync(path.join(t.dir, 'extract.json'), await run('python3', [LIB('extract.py'), msgPath(t.dir), t.node, t.dir]));
  stamp(t.dir);
  packMsg(t.dir);
}

// Data for a node, fastest source first. Both give the same code (byte-identical HTML/tree on the test frames):
//   1. the page document recorded by a recent capture (no browser, ~3-5s) — only if it is younger than
//      REFIGMA_DOC_MAX_AGE and every image of the node resolved; otherwise
//   2. a live editor capture: Figma's copy data + its PNG (~25-35s; the only source of frame.png, so `png` forces it).
// REFIGMA_PROTO=1 adds the prototype viewer between them (just the frame, ~10-25s; experimental: images the browser
// already cached are not seen, and those nodes fall back to 2). REFIGMA_SOURCE=clipboard always uses 2.
const fromDoc = async (t, args) => {
  await run('node', [LIB('doc.mjs'), ...args]);
  await extractFromMsg(t);
  const missing = JSON.parse(read(t, 'extract.json')).images_missing || [];
  if (missing.length) throw new Error(`images not resolved: ${missing.join(', ')}`);
};
const capture = (url, refresh, opts = {}) => serial(async () => {
  const t = parseUrl(url, opts.node);
  if (!t.node) throw new Error('This tool needs a node: pass a link with ?node-id= (right-click a frame → Copy link to selection) or node_id');
  const pngOk = !opts.png || has(t.dir, 'frame.png');
  const reuse = !refresh && pngOk && Date.now() - capturedAt(t.dir) < CACHE_MAX_AGE;
  if (reuse && has(t.dir, 'index.html') && currentExtract(t.dir)) return { ...t, cached: true };
  if (reuse && msgPath(t.dir)) { await extractFromMsg(t); return { ...t, cached: true }; }
  if (!opts.png && process.env.REFIGMA_SOURCE !== 'clipboard') {
    fs.mkdirSync(t.dir, { recursive: true });
    const msg = path.join(t.dir, 'msg.json');
    if (!refresh && hasDoc(t.fdir)) {
      try { await fromDoc(t, ['extract', t.fdir, t.node, msg, t.file]); return { ...t, cached: false, source: 'document' }; }
      catch { /* not on a recent recorded page, or an image without URL */ }
    }
    if (process.env.REFIGMA_PROTO === '1') {
      try {
        const pdir = path.join(t.fdir, '_proto', nodeDir(t.node));
        fs.rmSync(pdir, { recursive: true, force: true });
        await run('node', [LIB('capture.mjs'), t.protoUrl, pdir], 90_000);
        await fromDoc(t, ['extract-dir', pdir, t.node, msg, t.file]);
        return { ...t, cached: false, source: 'prototype' };
      } catch (e) { if (/NOT_LOGGED_IN/.test(e.message)) throw e; }
    }
    for (const f of MSG_FILES) fs.rmSync(path.join(t.dir, f), { force: true });
  }
  await run(READER, [t.nodeUrl, t.dir]);
  stamp(t.dir);
  packMsg(t.dir);
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
// A PNG inlined into an answer must stay within what MCP clients accept (big frames at 2x run to 20+MB / 8000+px)
const pngSize = f => { const b = fs.readFileSync(f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length }; };
const inlinable = f => { const { w, h, bytes } = pngSize(f); return w <= 7900 && h <= 7900 && bytes <= 5 << 20; };

const server = new McpServer({ name: 'refigma-mcp', version: '0.3.0' });

server.registerTool('figma_get_metadata', {
  title: 'Outline of a Figma file / node',
  description: 'Without a node: lists every page of the file and the sections/frames of the recorded page(s) as sparse XML (id, name, type, x, y, width, height). With a node: the outline under it to `depth`. Use it to discover frame ids, then call the other tools with node_id. Pages load lazily in Figma: to outline another page, pass a link whose node-id is on that page with refresh=true.',
  inputSchema: { url: URL_ARG, node_id: NODE_ARG, depth: z.number().int().positive().optional(), refresh: REFRESH,
    max_lines: z.number().int().positive().optional().describe('Truncate (default 1000 lines)') },
}, async ({ url, node_id, depth, refresh, max_lines = 1000 }) => {
  try {
    let t = await ensureDoc(url, refresh);
    // the link's node-id is the default root; pages are listed unless a node_id was asked for explicitly
    const node = node_id ? normNode(node_id) : t.node;
    const pages = node_id ? '' : await run('node', [LIB('doc.mjs'), 'pages', t.fdir]);
    const outlineOf = () => run('node', [LIB('doc.mjs'), 'outline', t.fdir, node || '', String(depth || (node ? 3 : 2))]);
    let outline;
    try { outline = await outlineOf(); }
    catch (e) {   // the node's page was never recorded: open the node (Figma then loads its page) and record it
      if (refresh || !/not on a captured page/.test(e.message)) throw e;
      t = await ensureDoc(node_id ? parseUrl(url, node).nodeUrl : url, true);
      outline = await outlineOf();
    }
    const lines = outline.split('\n');
    const body = lines.slice(0, max_lines).join('\n') + (lines.length > max_lines ? `\n… truncated (${lines.length} lines total): pass a deeper node_id or a smaller depth` : '');
    return text(`${pages ? `<pages>\n${pages}</pages>\n\n` : ''}${body}`);
  } catch (e) { return fail(e); }
});

server.registerTool('figma_search', {
  title: 'Find layers by name',
  description: 'Case-insensitive name search across the recorded page(s) of the file. Returns id, type, name, size and the path of each match.',
  inputSchema: { url: URL_ARG, query: z.string(), limit: z.number().int().positive().optional(), refresh: REFRESH },
}, async ({ url, query, limit, refresh }) => {
  try {
    const t = await ensureDoc(url, refresh);
    return text((await run('node', [LIB('doc.mjs'), 'search', t.fdir, query, String(limit || 50)])).trim() || `no layer named like "${query}" (this searches layer names, not text content)`);
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
    return text(`file=${r.file} node=${r.node} (${sourceNote(r)}) dir=${r.dir}\nlegend: WxH @x,y [dir gap pad=T R B L justify align size=main/cross] fill-main/fill-cross=stretch, colors #HEX(token), style{...}=Figma style names, on:event→action(target transition)\n\n${body}`);
  } catch (e) { return fail(e); }
});

server.registerTool('figma_get_nodes', {
  title: 'Read several nodes at once',
  description: 'Layout trees for several node ids of the same file. Nodes on an already-recorded page are extracted from the page document in seconds (no browser round-trip); others are captured live.',
  inputSchema: { url: URL_ARG, node_ids: z.array(z.string()).min(1), max_lines_each: z.number().int().positive().optional() },
}, async ({ url, node_ids, max_lines_each = 400 }) => {
  try {
    const errors = {}, source = {};
    const ids = [...new Set(node_ids.map(id => { try { return normNode(id); } catch (e) { errors[id] = e.message; return id; } }))];
    // Nodes on a recorded page: decode the page once for all of them, then build their outputs in parallel.
    await serial(async () => {
      const t = parseUrl(url);
      const todo = ids.filter(id => !errors[id]).filter(id => { const d = parseUrl(url, id).dir; return Date.now() - capturedAt(d) >= CACHE_MAX_AGE || (!(has(d, 'tree.txt') && currentExtract(d)) && !msgPath(d)); });
      if (!todo.length || !hasDoc(t.fdir)) return;
      const res = JSON.parse(await run('node', [LIB('doc.mjs'), 'extract-many', t.fdir, t.file, ...todo.map(id => `${id}=${path.join(parseUrl(url, id).dir, 'msg.json')}`)]));
      const ok = todo.filter(id => !res[id]?.error);
      await Promise.all(ok.map(async id => {
        const r = parseUrl(url, id);
        try {
          await extractFromMsg(r);
          // an image without a URL: leave the node to capture(), which falls back to a live capture
          if ((JSON.parse(read(r, 'extract.json')).images_missing || []).length) for (const f of MSG_FILES) fs.rmSync(path.join(r.dir, f), { force: true });
          else source[id] = 'document';
        } catch (e) { errors[id] = e.message; }
      }));
    });
    const parts = [];
    for (const id of ids) {
      try {
        if (errors[id]) throw new Error(errors[id]);
        const r = source[id] ? { ...parseUrl(url, id), source: source[id] } : await capture(url, false, { node: id });
        const lines = read(r, 'tree.txt').split('\n');
        parts.push(`### node ${r.node} (${sourceNote(r)})\n` + lines.slice(0, max_lines_each).join('\n') + (lines.length > max_lines_each ? `\n… truncated (${lines.length} lines)` : ''));
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
    return text(path_only ? p : `${p} (${sourceNote(r)})\n\n${read(r, f)}`);
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
      // relative to the client's working directory (the project) — the server's own cwd is not meaningful to the caller
      const root = path.resolve(process.env.PWD || process.cwd(), dest), replaced = [];
      for (const [sub, files] of [['icons', icons], ['images', images]]) {
        fs.mkdirSync(path.join(root, sub), { recursive: true });
        for (const f of files) {
          const to = path.join(root, sub, path.basename(f));
          if (fs.existsSync(to) && !fs.readFileSync(to).equals(fs.readFileSync(f))) replaced.push(to);
          fs.copyFileSync(f, to);
        }
      }
      note = `\ncopied to ${root}/icons and ${root}/images` + (replaced.length ? `\nreplaced ${replaced.length} different file(s) with the same name:\n${replaced.join('\n')}` : '');
    }
    return text(`${sourceNote(r)}\nicons (${icons.length}):\n${icons.join('\n')}\n\nimages (${images.length}):\n${images.join('\n')}${note}`);
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
    let r = await capture(url, false, t.node ? {} : { node: node_id });
    const id = normNode(node_id) || r.node;
    if (!fs.readFileSync(path.join(r.dir, 'index.html'), 'utf8').includes(`data-id="${id}"`)) r = await capture(url, false, { node: id });
    const out = dest || path.join(r.dir, 'exports', `${nodeDir(id)}@${scale}x.${format}`);
    const res = JSON.parse(await run('node', [LIB('export.mjs'), r.dir, id === r.node ? 'root' : id, format, String(scale), out], 180_000));
    const content = [{ type: 'text', text: `${res.out} (${res.width}x${res.height}, ${format} @${scale}x)` }];
    if (format === 'png' && inlinable(res.out)) content.push({ type: 'image', data: fs.readFileSync(res.out).toString('base64'), mimeType: 'image/png' });
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
    const r = await capture(url, refresh, { node: node_id, png: true });
    const png = path.join(r.dir, 'frame.png');
    if (!fs.existsSync(png)) return fail(new Error('Figma PNG not captured. Retry with refresh=true, or use figma_export.'));
    if (!inlinable(png)) { const { w, h, bytes } = pngSize(png);
      return text(`${png} (${sourceNote(r)})\n${w}x${h}, ${(bytes / 1e6).toFixed(1)}MB: too large to inline — open the file, or use figma_export with a node_id inside it`); }
    return { content: [{ type: 'image', data: fs.readFileSync(png).toString('base64'), mimeType: 'image/png' }, { type: 'text', text: `${png} (${sourceNote(r)})` }] };
  } catch (e) { return fail(e); }
});

server.registerTool('figma_compare', {
  title: 'Pixel-diff an implementation against the Figma node',
  description: "Renders target (a URL such as http://localhost:5173/page, an HTML file, or \"react\" for the generated component; default: the generated HTML) at the node's size in an sRGB headless Edge and diffs it with Figma's PNG. Returns match %, worst regions and the diff image (red = mismatch). Iterate until ~99.9%.",
  inputSchema: { url: URL_ARG, node_id: NODE_ARG, target: z.string().optional(), refresh: REFRESH,
    selector: z.string().optional().describe('CSS selector of the element to diff when target is a page of a running app'),
    viewport: z.string().regex(/^\d+x\d+$/).optional().describe('Page size with a selector, e.g. 1440x1024 (default)'),
    local_storage: z.record(z.string(), z.any()).optional().describe('Entries written to localStorage before the page loads (e.g. an auth token, for pages behind a login)'),
    settle_ms: z.number().int().nonnegative().max(30000).optional().describe('Wait after load for client-side rendering (default 400; 2500 for react)') },
}, async ({ url, node_id, target, refresh, selector, viewport, local_storage, settle_ms }) => {
  try {
    const r = await capture(url, refresh, { node: node_id, png: true });
    const png = path.join(r.dir, 'frame.png');
    if (!fs.existsSync(png)) return fail(new Error('No Figma PNG to compare against; run figma_get_image with refresh=true'));
    const { w, h } = JSON.parse(read(r, 'extract.json'));
    let file = target || path.join(r.dir, 'index.html');
    const env = { ...ENV };
    if (selector) env.COMPARE_SELECTOR = selector;
    if (viewport) env.COMPARE_VIEWPORT = viewport;
    if (local_storage) env.COMPARE_STORAGE = JSON.stringify(local_storage);
    if (settle_ms !== undefined) env.SETTLE_MS = String(settle_ms);
    if (target === 'react') {
      file = path.join(r.dir, 'react.html');
      await run('node', [LIB('render-tsx.mjs'), path.join(r.dir, componentFile(r)), file]);
      env.SETTLE_MS ||= '2500';   // Tailwind Play CDN compiles classes after load
    }
    const out = path.join(r.dir, 'compare', target ? (target === 'react' ? 'react' : 'target') : 'generated');
    const res = await new Promise((resolve, reject) => execFile('node', [LIB('compare.mjs'), file, png, String(w), String(h), out],
      { timeout: 300_000, env, maxBuffer: 64 << 20 }, (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).trim())) : resolve(JSON.parse(stdout))));
    const regions = res.worstRegions.map(c => `  x=${c.x} y=${c.y} ${c.w}x${c.h}: ${c.pct}% differs`).join('\n');
    return { content: [
      { type: 'text', text: `match ${res.match}% (${res.diffPixels} px differ)\nworst regions:\n${regions || '  none'}\nrender: ${res.render}\ndiff: ${res.diff}` },
      ...(inlinable(res.diff) ? [{ type: 'image', data: fs.readFileSync(res.diff).toString('base64'), mimeType: 'image/png' }] : []),
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
  const dirs = p => { try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; } };
  const lines = dirs(CACHE).map(f => {
    const nodes = dirs(path.join(CACHE, f)).filter(n => /^I?\d+-\d+(;\d+-\d+)*$/.test(n))
      .map(n => `${n.replaceAll('-', ':')} (${ago(capturedAt(path.join(CACHE, f, n)))} ago)`);
    return `${f}: document ${hasDoc(path.join(CACHE, f)) ? 'recorded' : 'no'}, captured nodes: ${nodes.join(', ') || 'none'}`;
  });
  let browser = 'headless browser not running (starts automatically on the next capture)';
  try { const v = await (await fetch('http://127.0.0.1:9334/json/version')).json(); browser = `headless browser: ${v.Browser} on :9334`; } catch {}
  return text(`${browser}\n${lines.join('\n') || 'no captures yet'}\nIf captures fail with NOT_LOGGED_IN, run figma_relogin.`);
});

await server.connect(new StdioServerTransport());
