// Render a page in the debug Edge at the frame's size and pixel-diff it against Figma's PNG.
// usage: node compare.mjs <html file | URL> <reference.png> <width> <height> <out dir>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const [target, refPath, W, H, outDir] = process.argv.slice(2);
const w = Math.round(+W), h = Math.round(+H);
const url = /^https?:|^file:/.test(target) ? target : 'file://' + path.resolve(target);

const cdp = async wsUrl => {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = {};
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending[m.id]) pending[m.id](m); };
  await new Promise(r => ws.onopen = r);
  const call = (method, params = {}) => new Promise((res, rej) => { pending[++id] = m => m.error ? rej(new Error(m.error.message)) : res(m.result); ws.send(JSON.stringify({ id, method, params })); });
  return { call, close: () => ws.close() };
};

// A private headless Edge: sRGB output (Figma exports sRGB; macOS Edge renders in the display's P3 space otherwise)
// and no extensions injecting widgets. The page under test needs no login, so the logged-in debug Edge isn't needed.
const EDGE = process.env.REFIGMA_BROWSER || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PORT = 9333;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'refigma-cmp-'));
const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--force-color-profile=srgb',
  '--hide-scrollbars', '--no-first-run', '--disable-extensions', '--font-render-hinting=none', 'about:blank'], { stdio: 'ignore' });
let version;
for (let i = 0; i < 60 && !version; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await new Promise(r => setTimeout(r, 200)); }
}
if (!version) { proc.kill(); throw new Error('could not start headless Edge for comparison'); }
process.on('exit', () => { proc.kill(); fs.rmSync(profile, { recursive: true, force: true }); });
const browser = await cdp(version.webSocketDebuggerUrl);
const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank', background: true });
const page = await cdp(`ws://127.0.0.1:${PORT}/devtools/page/${targetId}`);
let shot;
try {
  await page.call('Page.enable');
  await page.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await page.call('Page.navigate', { url });
  for (let i = 0; i < 60; i++) {
    const r = await page.call('Runtime.evaluate', { expression: "document.readyState === 'complete' && document.fonts.status === 'loaded' && [...document.images].every(i => i.complete)", returnByValue: true });
    if (r.result.value) break;
    await new Promise(r => setTimeout(r, 250));
  }
  // Browser extensions inject floating widgets (custom elements) into every page; drop them before the shot.
  await page.call('Runtime.evaluate', { expression: "[...document.querySelectorAll('html > *, body > *')].filter(e => e.tagName.includes('-') || e.shadowRoot && e.tagName !== 'DIV').forEach(e => e.remove()); if (location.protocol === 'file:') { const st = document.createElement('style'); st.textContent = 'html > :not(head):not(body), body > :not(.n1) { display: none !important; }'; document.head.append(st); }" });
  await new Promise(r => setTimeout(r, 400));
  shot = (await page.call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 }, captureBeyondViewport: true })).data;
} finally {
  page.close();
  await browser.call('Target.closeTarget', { targetId }).catch(() => {});
  browser.close();
}

const render = PNG.sync.read(Buffer.from(shot, 'base64'));
const ref = PNG.sync.read(fs.readFileSync(refPath));
const onWhite = img => { const d = img.data; for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; for (let k = 0; k < 3; k++) d[i + k] = Math.round(d[i + k] * a + 255 * (1 - a)); d[i + 3] = 255; } };
onWhite(render); onWhite(ref);

// Figma's export bounds include strokes/shadows that bleed outside the frame; find the frame's offset in it.
const crop = (img, ox, oy) => { const out = new PNG({ width: w, height: h }); PNG.bitblt(img, out, ox, oy, Math.min(w, img.width - ox), Math.min(h, img.height - oy), 0, 0); return out; };
let best = null;
for (let oy = 0; oy <= Math.max(0, ref.height - h); oy++)
  for (let ox = 0; ox <= Math.max(0, ref.width - w); ox++) {
    const r = crop(ref, ox, oy);
    const n = pixelmatch(r.data, render.data, null, w, h, { threshold: 0.1 });
    if (!best || n < best.n) best = { n, ox, oy, r };
  }
const diff = new PNG({ width: w, height: h });
const n = pixelmatch(best.r.data, render.data, diff.data, w, h, { threshold: 0.1, alpha: 0.3 });

// Where are the mismatches? 8x8 grid, worst cells first.
const cells = [];
const gw = Math.ceil(w / 8), gh = Math.ceil(h / 8);
for (let gy = 0; gy < 8; gy++) for (let gx = 0; gx < 8; gx++) {
  let c = 0;
  for (let y = gy * gh; y < Math.min(h, (gy + 1) * gh); y++) for (let x = gx * gw; x < Math.min(w, (gx + 1) * gw); x++) {
    const i = (y * w + x) * 4; if (diff.data[i] === 255 && diff.data[i + 1] === 0) c++;
  }
  if (c) cells.push({ x: gx * gw, y: gy * gh, w: gw, h: gh, pct: +(100 * c / (gw * gh)).toFixed(2) });
}
cells.sort((a, b) => b.pct - a.pct);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'render.png'), PNG.sync.write(render));
fs.writeFileSync(path.join(outDir, 'diff.png'), PNG.sync.write(diff));
const result = { target: url, match: +(100 - 100 * n / (w * h)).toFixed(3), diffPixels: n, offset: [best.ox, best.oy], worstRegions: cells.slice(0, 6),
  render: path.join(outDir, 'render.png'), diff: path.join(outDir, 'diff.png') };
fs.writeFileSync(path.join(outDir, 'compare.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result));
process.exit(0);
