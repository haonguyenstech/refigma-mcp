// Work with a recorded multiplayer document (lib/capture.mjs) of a Figma file.
//   node doc.mjs ingest  <fileDir>                     decode _doc/_new, store as _doc/<pageId>, write pages.json + outline
//   node doc.mjs pages   <fileDir>
//   node doc.mjs outline <fileDir> [nodeId] [depth]    sparse XML outline (whole loaded page when no node)
//   node doc.mjs search  <fileDir> <query> [limit]
//   node doc.mjs extract <fileDir> <nodeId> <out msg.json>   node + dependency closure in decode.mjs's msg.json format
//   node doc.mjs extract-many <fileDir> <fileKey> <nodeId=out.json>...   same, decoding the page once for all nodes
//   node doc.mjs extract-dir <docDir> <nodeId> <out msg.json> <fileKey>   from a prototype capture (capture.mjs /proto/)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { decompress as zstd } from 'fzstd';
import * as pako from 'pako';

const [cmd, fileDir, ...args] = process.argv.slice(2);
const DOCS = path.join(fileDir, '_doc');
const g = x => `${x.sessionID}:${x.localID}`;
// native zstd (Node ≥ 22.15) is ~4x faster than fzstd on the 160MB page snapshot
const unzstd = zlib.zstdDecompressSync ? c => new Uint8Array(zlib.zstdDecompressSync(c)) : zstd;
const un = c => (c[0] === 0x28 && c[1] === 0xb5 && c[2] === 0x2f && c[3] === 0xfd) ? unzstd(c) : pako.inflateRaw(c);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function decodeDir(dir) {
  const raw = new Uint8Array(fs.readFileSync(path.join(dir, 'schema.bin')));
  const schema = compileSchema(decodeBinarySchema(un(raw.subarray(12))));   // "fig-wire" + u32 version + zstd schema
  const byGuid = new Map(), blobs = [];
  for (const f of JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'))) {
    let msg; try { msg = schema.decodeMessage(un(new Uint8Array(fs.readFileSync(path.join(dir, f))))); } catch { continue; }
    if (!msg.nodeChanges?.length) continue;
    const base = blobs.length;
    for (const b of msg.blobs || []) blobs.push(b);
    if (base) shiftBlobs(msg.nodeChanges, base);
    // frames after the snapshot are edits made while recording: a change carries only the fields it changed
    for (const n of msg.nodeChanges) {
      const k = g(n.guid);
      if (n.phase === 'REMOVED') { byGuid.delete(k); continue; }
      if (byGuid.has(k)) Object.assign(byGuid.get(k), n); else byGuid.set(k, n);
    }
  }
  return { nodes: [...byGuid.values()], blobs };
}

// blob references are integer fields whose name ends in "Blob"
function walkBlobs(o, fn) {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) { for (const x of o) walkBlobs(x, fn); return; }
  for (const [k, v] of Object.entries(o)) {
    if (/Blob$/.test(k) && typeof v === 'number') o[k] = fn(v);
    else if (v && typeof v === 'object' && !(v instanceof Uint8Array)) walkBlobs(v, fn);
  }
}
const shiftBlobs = (nodes, base) => walkBlobs(nodes, i => i + base);

function index(nodes) {
  const byId = new Map(), kids = new Map();
  for (const n of nodes) {
    byId.set(g(n.guid), n);
    if (n.parentIndex) { const p = g(n.parentIndex.guid); if (!kids.has(p)) kids.set(p, []); kids.get(p).push(n); }
  }
  for (const v of kids.values()) v.sort((a, b) => a.parentIndex.position < b.parentIndex.position ? -1 : 1);
  return { byId, kids };
}

const INTERNAL = new Set(['VARIABLE', 'VARIABLE_SET', 'VARIABLE_OVERRIDE']);
function loadedPages(nodes, kids) {
  // a page is loaded when its children came down; the internal canvas only holds components/variables
  return nodes.filter(n => n.type === 'CANVAS' && (kids.get(g(n.guid)) || []).length && !/internal only canvas/i.test(n.name || ''));
}

if (cmd === 'ingest') {
  const src = path.join(DOCS, '_new');
  const { nodes } = decodeDir(src);
  const { kids } = index(nodes);
  const pages = nodes.filter(n => n.type === 'CANVAS').map(p => ({ id: g(p.guid), name: p.name, loaded: (kids.get(g(p.guid)) || []).length > 0 }));
  const loaded = loadedPages(nodes, kids).map(p => g(p.guid));
  const key = (loaded[0] || 'unknown').replace(':', '-');
  const dst = path.join(DOCS, key);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.renameSync(src, dst);
  // outline of every node on the loaded page(s): [id, parent, type, name, x, y, w, h]
  const rows = [];
  const visit = (n, parent) => {
    const t = n.transform || {}, s = n.size || {};
    rows.push([g(n.guid), parent, n.type, n.name || '', Math.round(t.m02 || 0), Math.round(t.m12 || 0), Math.round(s.x || 0), Math.round(s.y || 0), n.visible === false ? 0 : 1]);
    for (const c of kids.get(g(n.guid)) || []) visit(c, g(n.guid));
  };
  for (const pid of loaded) visit(nodes.find(n => g(n.guid) === pid), null);
  fs.writeFileSync(path.join(dst, 'outline.json'), JSON.stringify(rows));
  const old = fs.existsSync(path.join(fileDir, 'pages.json')) ? JSON.parse(fs.readFileSync(path.join(fileDir, 'pages.json'), 'utf8')) : {};
  const merged = { pages: pages.map(p => ({ ...p, loaded: undefined })), docs: { ...(old.docs || {}), ...Object.fromEntries(loaded.map(id => [id, key])) } };
  fs.writeFileSync(path.join(fileDir, 'pages.json'), JSON.stringify(merged, null, 1));
  console.log(JSON.stringify({ doc: key, nodes: nodes.length, pages: pages.length, loaded }));
  process.exit(0);
}

// REFIGMA_DOC_MAX_AGE (seconds): ignore page documents recorded longer ago (the design may have changed since)
const MAX_AGE = +process.env.REFIGMA_DOC_MAX_AGE || 0;
const fresh = d => { if (!MAX_AGE) return true;
  try { return Date.now() - Date.parse(JSON.parse(fs.readFileSync(path.join(DOCS, d, 'meta.json'), 'utf8')).at) < MAX_AGE * 1000; } catch { return false; } };
function allOutlines(forExtract = false) {
  if (!fs.existsSync(DOCS)) return [];
  return fs.readdirSync(DOCS).filter(d => d !== '_new' && fs.existsSync(path.join(DOCS, d, 'outline.json')) && (!forExtract || fresh(d)))
    .map(d => ({ doc: d, rows: JSON.parse(fs.readFileSync(path.join(DOCS, d, 'outline.json'), 'utf8')) }));
}
function findDoc(nodeId) {
  for (const o of allOutlines()) if (o.rows.some(r => r[0] === nodeId)) return o;
  return null;
}

if (cmd === 'pages') {
  const p = fs.existsSync(path.join(fileDir, 'pages.json')) ? JSON.parse(fs.readFileSync(path.join(fileDir, 'pages.json'), 'utf8')) : { pages: [], docs: {} };
  for (const pg of p.pages) console.log(`<page id="${pg.id}" name="${esc(pg.name)}"${p.docs[pg.id] ? ' captured="true"' : ''}/>`);
  process.exit(0);
}

if (cmd === 'outline') {
  const [nodeId, depthArg] = args;
  const depth = +depthArg || (nodeId ? 3 : 2);
  const o = nodeId ? findDoc(nodeId) : allOutlines()[0];
  if (!o) { console.error(nodeId ? `node ${nodeId} is not on a captured page` : 'no captured page'); process.exit(2); }
  const kids = new Map(); for (const r of o.rows) { if (!kids.has(r[1])) kids.set(r[1], []); kids.get(r[1]).push(r); }
  const roots = nodeId ? o.rows.filter(r => r[0] === nodeId) : o.rows.filter(r => r[1] === null);
  const out = [];
  const emit = (r, d) => {
    const tag = r[2].toLowerCase().replace(/_/g, '-');
    const ch = kids.get(r[0]) || [];
    const attrs = `id="${r[0]}" name="${esc(r[3])}" x="${r[4]}" y="${r[5]}" width="${r[6]}" height="${r[7]}"${r[8] ? '' : ' hidden="true"'}`;
    if (!ch.length) return out.push(`${'  '.repeat(d)}<${tag} ${attrs}/>`);
    if (d >= depth) return out.push(`${'  '.repeat(d)}<${tag} ${attrs} children="${ch.length}"/>`);
    out.push(`${'  '.repeat(d)}<${tag} ${attrs}>`);
    for (const c of ch) emit(c, d + 1);
    out.push(`${'  '.repeat(d)}</${tag}>`);
  };
  for (const r of roots) emit(r, 0);
  console.log(out.join('\n'));
  process.exit(0);
}

if (cmd === 'search') {
  const [q, lim] = args; const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const hits = [];
  for (const o of allOutlines()) {
    const byId = new Map(o.rows.map(r => [r[0], r]));
    for (const r of o.rows) if (re.test(r[3])) {
      const trail = []; let p = r[1]; while (p && byId.has(p)) { trail.unshift(byId.get(p)[3]); p = byId.get(p)[1]; }
      hits.push(`${r[0]}  ${r[2]}  "${r[3]}"  ${r[6]}x${r[7]}  in ${trail.join(' / ')}`);
    }
  }
  console.log(hits.slice(0, +lim || 50).join('\n') + (hits.length > (+lim || 50) ? `\n… ${hits.length} matches` : ''));
  process.exit(0);
}

function extractNode(doc, nodeId, outFile, fileKey, imageHashes) {
  const { nodes, blobs, byId, kids } = doc;
  const keep = new Set();
  const addTree = id => {
    if (keep.has(id) || !byId.has(id)) return;
    keep.add(id);
    const n = byId.get(id);
    const refs = [];
    if (n.symbolData?.symbolID) refs.push(g(n.symbolData.symbolID));
    if (n.overriddenSymbolID) refs.push(g(n.overriddenSymbolID));
    for (const e of n.symbolData?.symbolOverrides || []) if (e.overriddenSymbolID) refs.push(g(e.overriddenSymbolID));
    // instance-swap values: `value.guidValue`, or only `varValue…symbolIdValue.guid` in newer files
    const swap = a => a.value?.guidValue || a.varValue?.value?.symbolIdValue?.guid;
    for (const a of n.componentPropAssignments || []) if (swap(a)) refs.push(g(swap(a)));
    for (const e of n.symbolData?.symbolOverrides || []) for (const a of e.componentPropAssignments || []) if (swap(a)) refs.push(g(swap(a)));
    // hover/press variants (CHANGE_TO / SWAP_STATE targets) are components: keep them, not navigation targets (frames)
    for (const it of n.prototypeInteractions || []) for (const a of it.actions || [])
      if (a.transitionNodeID && byId.get(g(a.transitionNodeID))?.type === 'SYMBOL') refs.push(g(a.transitionNodeID));
    for (const r of refs) { addTree(r); const s = byId.get(r); if (s?.parentIndex) keep.add(g(s.parentIndex.guid)); }   // + component set (prop defaults)
    for (const c of kids.get(id) || []) addTree(g(c.guid));
  };
  addTree(nodeId);
  // variables, collections and style definitions are small and referenced by key: keep them all
  for (const n of nodes) if (INTERNAL.has(n.type) || n.styleType) keep.add(g(n.guid));
  const picked = nodes.filter(n => keep.has(g(n.guid))).map(n => structuredClone(n));
  // match Figma's copy handler: the root's position is absolute on the canvas (the document stores it relative to
  // its parent section)
  const root = picked.find(n => g(n.guid) === nodeId);
  if (root?.transform) {
    for (let p = byId.get(g(root.parentIndex?.guid || {})); p && p.type !== 'CANVAS'; p = p.parentIndex && byId.get(g(p.parentIndex.guid))) {
      root.transform.m02 += p.transform?.m02 || 0; root.transform.m12 += p.transform?.m12 || 0;
    }
  }
  // the root must not dangle from an unkept parent's z-order
  const used = new Map(), newBlobs = [];
  walkBlobs(picked, i => { if (!used.has(i)) { used.set(i, newBlobs.length); newBlobs.push(blobs[i]); } return used.get(i); });
  const replacer = (k, v) => v instanceof Uint8Array ? (v.length <= 64 ? Buffer.from(v).toString('hex') : 'b64:' + Buffer.from(v).toString('base64'))
    : typeof v === 'bigint' ? Number(v) : v;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ nodeChanges: picked, blobs: newBlobs, __figmeta: { fileKey, source: 'multiplayer', ...(imageHashes ? { imageHashes } : {}) } }, replacer));
  return { nodes: picked.length, blobs: newBlobs.length };
}

// image hash -> signed URL seen while the document was recorded (capture.mjs)
const readImages = dir => fs.existsSync(path.join(dir, 'images.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'images.json'), 'utf8')) : undefined;

// jobs: [[nodeId, outFile]]; every page document is decoded once, whatever the number of nodes on it
function extractMany(jobs, fileKey) {
  const outlines = allOutlines(true), byDoc = new Map(), result = {};
  for (const [nodeId, out] of jobs) {
    const o = outlines.find(o => o.rows.some(r => r[0] === nodeId));
    if (!o) { result[nodeId] = { error: `node ${nodeId} is not on a recently captured page` }; continue; }
    if (!byDoc.has(o.doc)) byDoc.set(o.doc, []);
    byDoc.get(o.doc).push([nodeId, out]);
  }
  for (const [d, list] of byDoc) {
    const { nodes, blobs } = decodeDir(path.join(DOCS, d));
    const doc = { nodes, blobs, ...index(nodes) };
    const imgs = readImages(path.join(DOCS, d));
    for (const [nodeId, out] of list) result[nodeId] = extractNode(doc, nodeId, out, fileKey, imgs);
  }
  return result;
}

if (cmd === 'extract') {
  const [nodeId, outFile, fileKey] = args;
  const r = extractMany([[nodeId, outFile]], fileKey)[nodeId];
  if (r.error) { console.error(r.error); process.exit(2); }
  console.log(JSON.stringify(r));
  process.exit(0);
}

if (cmd === 'extract-dir') {
  const [nodeId, outFile, fileKey] = args;
  const { nodes, blobs } = decodeDir(fileDir);
  const doc = { nodes, blobs, ...index(nodes) };
  if (!doc.byId.has(nodeId)) { console.error(`node ${nodeId} is not in this capture`); process.exit(2); }
  console.log(JSON.stringify(extractNode(doc, nodeId, outFile, fileKey, readImages(fileDir))));
  process.exit(0);
}

if (cmd === 'extract-many') {
  const [fileKey, ...pairs] = args;
  console.log(JSON.stringify(extractMany(pairs.map(p => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]), fileKey)));
  process.exit(0);
}

console.error('unknown command'); process.exit(1);
