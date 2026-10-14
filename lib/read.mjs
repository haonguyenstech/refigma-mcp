// read.mjs <figma design URL with node-id> [outdir] — the live capture behind bin/figma-read and the MCP server.
// Opens the link in refigma's headless Edge (no window; FigmaAgent blocked so Figma Desktop never opens),
// records the page document, copies the node, decodes Figma's clipboard binary locally and writes
// tree.txt, index.html, <Component>.tsx, assets/, tokens.json (+ frame.png). No REST API, no quota.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonCmd, PYTHON_ENV } from './env.mjs';

const LIB = path.dirname(fileURLToPath(import.meta.url));
const [url, outArg] = process.argv.slice(2);
if (!url) { console.error('usage: figma-read <figma design URL with node-id> [outdir]'); process.exit(64); }
const u = new URL(url);
const node = u.searchParams.get('node-id')?.replaceAll('-', ':');
const m = u.pathname.match(/\/(?:design|file|proto)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/);
if (!node || !m) { console.error('expected a figma.com/design/<fileKey>/… link with ?node-id='); process.exit(64); }
const fdir = path.join(os.homedir(), '.figma-local', 'out', m[2] || m[1]);
const out = outArg || path.join(fdir, node.replaceAll(':', '-'));
const docNew = path.join(fdir, '_doc', '_new');
fs.mkdirSync(out, { recursive: true });
fs.rmSync(docNew, { recursive: true, force: true });

const env = { ...process.env, ...PYTHON_ENV, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-semi-space-size=64`.trim() };
// stdout is kept when asked for; stderr always reaches ours, as the bash version did
function run(cmd, args, { capture = false, cwd } = {}) {
  const p = spawn(cmd, args, { env, cwd, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'inherit'], windowsHide: true });
  let stdout = '';
  if (capture) p.stdout.on('data', d => { stdout += d; });
  const done = new Promise((resolve, reject) => {
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(stdout) : reject(Object.assign(new Error(`${path.basename(args[0] || cmd)} exited with ${code}`), { code })));
  });
  return { p, done };
}

const cap = run(process.execPath, [path.join(LIB, 'capture.mjs'), url, docNew, out]);
let capExited = false;
cap.done.then(() => { capExited = true; }, () => { capExited = true; });
// The page document is saved (meta.json last) ~10s before the copy can run, while Figma is still busy loading it:
// ingest it (decodes ~150k nodes) in that window instead of afterwards.
while (!fs.existsSync(path.join(docNew, 'meta.json')) && !capExited) await new Promise(r => setTimeout(r, 200));
const ingest = fs.existsSync(path.join(docNew, 'meta.json'))
  ? run(process.execPath, [path.join(LIB, 'doc.mjs'), 'ingest', fdir]).done.catch(() => console.error('warning: document ingest failed'))
  : null;
try { await cap.done; } catch (e) { await ingest; process.exit(e.code || 1); }
await run(process.execPath, [path.join(LIB, 'decode.mjs'), path.join(out, 'clip.html'), path.join(out, 'msg.json')], { cwd: path.dirname(LIB) }).done;
const [py, ...pyArgs] = pythonCmd();
const extract = await run(py, [...pyArgs, path.join(LIB, 'extract.py'), path.join(out, 'msg.json'), node, out], { capture: true }).done;
fs.writeFileSync(path.join(out, 'extract.json'), extract);
await ingest;
console.log(`OK → ${out}  ${extract.trim()}`);
