// Render a page in the debug Edge at the frame's size and pixel-diff it against Figma's PNG.
// usage: node compare.mjs <html file | URL> <reference.png> <width> <height> <out dir>
import fs from 'node:fs';
import path from 'node:path';
import { openPage } from './headless.mjs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const [target, refPath, W, H, outDir] = process.argv.slice(2);
let w = Math.round(+W), h = Math.round(+H);
const url = /^https?:|^file:/.test(target) ? target : 'file://' + path.resolve(target);

const refProbe = PNG.sync.read(fs.readFileSync(refPath));
const S = Math.max(1, Math.round(refProbe.width / w));
const view = await openPage({ width: w, height: h, scale: S });
let shot;
try {
  await view.load(url);
  shot = (await view.page.call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 }, captureBeyondViewport: true })).data;
  w = w * S; h = h * S;
} finally { view.close(); }

const render = PNG.sync.read(Buffer.from(shot, 'base64'));
const ref = PNG.sync.read(fs.readFileSync(refPath));
const onWhite = img => { const d = img.data; for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; for (let k = 0; k < 3; k++) d[i + k] = Math.round(d[i + k] * a + 255 * (1 - a)); d[i + 3] = 255; } };
onWhite(render); onWhite(ref);

// Figma's export bounds include strokes/shadows that bleed outside the frame; find the frame's offset in it.
const crop = (img, ox, oy) => { const out = new PNG({ width: w, height: h }); PNG.bitblt(img, out, ox, oy, Math.min(w, img.width - ox), Math.min(h, img.height - oy), 0, 0); return out; };
// coarse-to-fine: search offsets on downsampled copies, then refine around the best at full resolution
const gray = (img, k) => { const W = Math.floor(img.width / k), H = Math.floor(img.height / k), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0; for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) { const p = ((y * k + j) * img.width + x * k + i) * 4; s += img.data[p] + img.data[p + 1] + img.data[p + 2]; } out[y * W + x] = s / (k * k * 3); }
  return { W, H, d: out }; };
const k = Math.max(1, Math.floor(Math.max(w, h) / 500));
const gr = gray(ref, k), gn = gray(render, k);
let coarse = { e: Infinity, ox: 0, oy: 0 };
for (let oy = 0; oy <= Math.max(0, gr.H - gn.H); oy++) for (let ox = 0; ox <= Math.max(0, gr.W - gn.W); ox++) {
  let e = 0; for (let y = 0; y < gn.H; y += 2) for (let x = 0; x < gn.W; x += 2) e += Math.abs(gr.d[(y + oy) * gr.W + x + ox] - gn.d[y * gn.W + x]);
  if (e < coarse.e) coarse = { e, ox, oy };
}
let best = null;
for (let oy = Math.max(0, coarse.oy * k - k); oy <= Math.min(Math.max(0, ref.height - h), coarse.oy * k + k); oy++)
  for (let ox = Math.max(0, coarse.ox * k - k); ox <= Math.min(Math.max(0, ref.width - w), coarse.ox * k + k); ox++) {
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
const result = { target: url, scale: S, match: +(100 - 100 * n / (w * h)).toFixed(3), diffPixels: n, offset: [best.ox, best.oy], worstRegions: cells.slice(0, 6),
  render: path.join(outDir, 'render.png'), diff: path.join(outDir, 'diff.png') };
fs.writeFileSync(path.join(outDir, 'compare.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result));
process.exit(0);
