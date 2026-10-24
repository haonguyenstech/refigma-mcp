// Self-update: an install keeps its config (one npx URL) forever and still runs the latest release.
// The launcher (bin/refigma-mcp.mjs) starts the newest copy under ~/.figma-local/app/<version>/ and runs this file
// detached; it fetches the latest GitHub release into that folder, and the next start of the server picks it up.
//   node update.mjs [--force]      check now (otherwise at most every REFIGMA_UPDATE_EVERY seconds, default 6h)
// REFIGMA_AUTO_UPDATE=0 turns it off (the launcher then runs the version in the config).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = 'haonguyenstech/refigma-mcp';
export const APP = path.join(os.homedir(), '.figma-local', 'app');
const STAMP = path.join(APP, '.checked');
const LOG = path.join(APP, 'update.log');
const IS_WIN = process.platform === 'win32';

export const cmpVer = (a, b) => {
  const p = v => String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map(Number);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

// Installed releases, newest first: folders with a finished install (.ready) and a server
export function installed() {
  let names = [];
  try { names = fs.readdirSync(APP); } catch {}
  return names.filter(v => /^\d+\.\d+\.\d+$/.test(v) && fs.existsSync(path.join(APP, v, '.ready')) && fs.existsSync(path.join(APP, v, 'server.mjs')))
    .sort((a, b) => cmpVer(b, a));
}

const log = msg => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch {} };

async function main() {
  const force = process.argv.includes('--force');
  fs.mkdirSync(APP, { recursive: true });
  const every = Number(process.env.REFIGMA_UPDATE_EVERY || 21600) * 1000;
  try { if (!force && Date.now() - fs.statSync(STAMP).mtimeMs < every) return; } catch {}
  fs.writeFileSync(STAMP, '');   // also the throttle for sessions starting at the same time

  const self = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`,
    { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'refigma-mcp' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) return log(`releases/latest ${r.status}`);
  const rel = await r.json();
  const ver = String(rel.tag_name || '').replace(/^v/, '');
  const asset = (rel.assets || []).find(a => /^refigma-mcp-.*\.tgz$/.test(a.name));
  if (!/^\d+\.\d+\.\d+$/.test(ver) || !asset) return log(`latest release ${rel.tag_name}: no package`);
  const have = [self, ...installed()].sort((a, b) => cmpVer(b, a))[0];
  if (cmpVer(ver, have) <= 0) return;

  // download + unpack + install deps in a temp folder, then rename into place: a half-done install is never picked
  const tmp = path.join(APP, `.tmp-${ver}-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
  try {
    const t = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120_000) });
    if (!t.ok) throw new Error(`download ${t.status}`);
    const tgz = path.join(tmp, 'pkg.tgz');
    fs.writeFileSync(tgz, Buffer.from(await t.arrayBuffer()));
    const run = (cmd, args, opt = {}) => {
      const p = spawnSync(cmd, args, { cwd: tmp, encoding: 'utf8', windowsHide: true, timeout: 300_000, ...opt });
      if (p.status !== 0) throw new Error(`${path.basename(cmd)} ${args[0]}: ${(p.stderr || p.error?.message || '').trim().slice(-300)}`);
    };
    run('tar', ['-xzf', 'pkg.tgz', '--strip-components=1']);   // bsdtar on macOS and Windows 10+
    fs.rmSync(tgz);
    // npm next to the node running us (Desktop apps start servers with a bare PATH)
    const npm = path.join(path.dirname(process.execPath), IS_WIN ? 'npm.cmd' : 'npm');
    run(fs.existsSync(npm) ? npm : 'npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
      { shell: IS_WIN, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` } });
    fs.writeFileSync(path.join(tmp, '.ready'), ver);
    const dst = path.join(APP, ver);
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(tmp, dst);
    log(`installed ${ver} (was ${have}); used from the next start`);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return log(`update to ${ver} failed: ${e.message}`);
  }
  // keep the two newest copies; a running server keeps its files open, so an old one is only removed when unused
  for (const v of installed().slice(2)) { try { fs.rmSync(path.join(APP, v), { recursive: true, force: true }); } catch {} }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => log(`update check failed: ${e.message}`)).finally(() => process.exit(0));
}
