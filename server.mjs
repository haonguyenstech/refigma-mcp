#!/usr/bin/env node
// refigma-mcp: MCP wrapper around bin/figma-read.
// Reads Figma frames by copying the node in a logged-in debug Edge (CDP :9222) and decoding
// Figma's clipboard binary locally — no REST API quota, no plugin, works on View seats.
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

function parseUrl(url) {
  const u = new URL(url);
  const file = u.pathname.match(/\/(?:design|file|proto)\/([A-Za-z0-9]+)/)?.[1];
  const node = u.searchParams.get('node-id')?.replace('-', ':');
  if (!file || !node) throw new Error('URL must be a figma.com/design link with ?node-id= (right-click a frame → Copy link to selection)');
  return { file, node, dir: path.join(CACHE, file, node.replace(':', '-')) };
}

// One debug browser, so captures must not overlap.
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn, fn));

function capture(url, refresh) {
  const t = parseUrl(url);
  const tree = path.join(t.dir, 'tree.txt');
  if (!refresh && fs.existsSync(tree)) return Promise.resolve({ ...t, cached: true });
  return serial(() => new Promise((resolve, reject) => {
    execFile(READER, [url, t.dir], { timeout: 240_000, env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` } },
      (err, stdout, stderr) => err ? reject(new Error((stderr || stdout || err.message).trim())) : resolve({ ...t, cached: false }));
  }));
}

const text = s => ({ content: [{ type: 'text', text: s }] });
const fail = e => ({ isError: true, content: [{ type: 'text', text: String(e.message || e) }] });

const server = new McpServer({ name: 'refigma-mcp', version: '0.1.0' });

server.registerTool('figma_get_node', {
  title: 'Read a Figma frame as a layout tree',
  description: 'Returns a compact layout tree for the node in a Figma link: auto-layout (row/col, gap, padding, justify/align, grow/stretch), size/position, fills with design-token names, borders, radius, shadow, fonts and text. Component instances are expanded with overrides applied. Results are cached; pass refresh=true after the design changes. When a detail looks off, trust figma_get_image.',
  inputSchema: {
    url: z.string().describe('figma.com/design/... link containing node-id'),
    refresh: z.boolean().optional().describe('Re-capture instead of using the cache'),
    max_lines: z.number().int().positive().optional().describe('Truncate the tree (default 1500 lines)'),
  },
}, async ({ url, refresh, max_lines = 1500 }) => {
  try {
    const r = await capture(url, refresh);
    const lines = fs.readFileSync(path.join(r.dir, 'tree.txt'), 'utf8').split('\n');
    const body = lines.slice(0, max_lines).join('\n') + (lines.length > max_lines ? `\n… truncated (${lines.length} lines total)` : '');
    return text(`file=${r.file} node=${r.node} ${r.cached ? '(cached)' : '(fresh)'}\nlegend: WxH @x,y [row|col gap pad=T R B L justify align] bg/color=#HEX(token)\n\n${body}`);
  } catch (e) { return fail(e); }
});

server.registerTool('figma_get_image', {
  title: 'Render a Figma frame as PNG',
  description: 'Returns the node from a Figma link exported as a 1x PNG (Figma "Copy as PNG"). Use as the visual reference when implementing the design.',
  inputSchema: { url: z.string(), refresh: z.boolean().optional() },
}, async ({ url, refresh }) => {
  try {
    const r = await capture(url, refresh);
    const png = path.join(r.dir, 'frame.png');
    if (!fs.existsSync(png)) return fail(new Error('PNG was not captured; retry with refresh=true'));
    return { content: [{ type: 'image', data: fs.readFileSync(png).toString('base64'), mimeType: 'image/png' }, { type: 'text', text: png }] };
  } catch (e) { return fail(e); }
});

server.registerTool('figma_get_tokens', {
  title: 'List design tokens used by a Figma frame',
  description: 'Lists every design-token (Figma variable) referenced in the node with its resolved hex value and usage count — useful for mapping to CSS variables / Tailwind theme.',
  inputSchema: { url: z.string(), refresh: z.boolean().optional() },
}, async ({ url, refresh }) => {
  try {
    const r = await capture(url, refresh);
    const tree = fs.readFileSync(path.join(r.dir, 'tree.txt'), 'utf8');
    const seen = new Map();
    for (const m of tree.matchAll(/(#[0-9A-F]{6}(?:\/[\d.]+)?)\(((?:[^()]|\([^()]*\))+)\)/g)) {
      const k = `${m[2]} = ${m[1]}`; seen.set(k, (seen.get(k) || 0) + 1);
    }
    const fonts = new Map();
    for (const m of tree.matchAll(/font=([^"]+?) (?=color=|")/g)) fonts.set(m[1].trim(), (fonts.get(m[1].trim()) || 0) + 1);
    const fmt = map => [...map].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => `${k}  ×${n}`).join('\n');
    return text(`Color tokens (${seen.size}):\n${fmt(seen)}\n\nText styles (${fonts.size}):\n${fmt(fonts)}`);
  } catch (e) { return fail(e); }
});

server.registerTool('figma_status', {
  title: 'Check refigma prerequisites',
  description: 'Checks that the debug Edge is up on CDP :9222 and logged in to figma.com.',
  inputSchema: {},
}, async () => {
  try {
    const v = await (await fetch('http://127.0.0.1:9222/json/version')).json();
    const tabs = await (await fetch('http://127.0.0.1:9222/json')).json();
    const fig = tabs.filter(t => t.type === 'page' && t.url.includes('figma.com'));
    return text(`debug browser: ${v.Browser}\nfigma tabs: ${fig.length}\ncache: ${CACHE}\nIf captures fail with "editor did not load", re-import figma.com cookies (import-cookie skill) into the debug Edge.`);
  } catch {
    return text('debug Edge is not running on :9222 — it will be launched automatically on the first capture (~/.claude/skills/agent-browser-connect/connect.sh).');
  }
});

await server.connect(new StdioServerTransport());
