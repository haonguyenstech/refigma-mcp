// Render a page in the debug Edge at the frame's size and pixel-diff it against Figma's PNG.
// usage: node compare.mjs <html file | URL> <reference.png> <width> <height> <out dir>
// env: COMPARE_SELECTOR  diff only that element of the page (e.g. a component inside a running app)
//      COMPARE_VIEWPORT  WxH of the page when a selector is used (default 1440x1024)
//      COMPARE_STORAGE   JSON object written to localStorage before the page's own scripts run (e.g. an auth token)
import fs from 'node:fs';
import path from 'node:path';
import { openPage } from './headless.mjs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const [target, refPath, W, H, outDir] = process.argv.slice(2);
let w = Math.round(+W), h = Math.round(+H);
const url = /^https?:|^file:/.test(target) ? target : 'file://' + path.resolve(target);

const refProbe = PNG.sync.read(fs.readFileSync(refPath));
// Figma's PNG scale is not always an integer (a 375x812 frame came at 500x1083, 4/3): take the candidate whose frame
// fits the PNG best (bleeding strokes/shadows only ever make the PNG larger)
const S = [1, 4 / 3, 1.5, 2, 3, 4].map(c => ({ c, e: Math.max(refProbe.width - w * c, refProbe.height - h * c) }))
  .filter(o => o.e > -2).sort((a, b) => a.e - b.e)[0]?.c || 1;
const SEL = process.env.COMPARE_SELECTOR;
const [VW, VH] = (process.env.COMPARE_VIEWPORT || '1440x1024').split('x').map(Number);
const view = await openPage(SEL ? { width: VW, height: VH, scale: S } : { width: w, height: h, scale: S });
let shot;
try {
  if (process.env.COMPARE_STORAGE)
    await view.page.call('Page.addScriptToEvaluateOnNewDocument', { source: `try { for (const [k, v] of Object.entries(${process.env.COMPARE_STORAGE}))
      localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch {}` });
  await view.load(url);
  let clip = { x: 0, y: 0, width: w, height: h };
  if (SEL) {
    clip = await view.evalv(`(() => { const e = document.querySelector(${JSON.stringify(SEL)}); if (!e) return null;
      const r = e.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`);
    if (!clip) throw new Error(`selector ${SEL} matched nothing on ${url}`);
    w = Math.round(clip.width); h = Math.round(clip.height);
  }
  shot = (await view.page.call('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: true })).data;
  w = Math.round(w * S); h = Math.round(h * S);
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
// refine: rank the offsets around the coarse hit by grey-level error at full resolution (cheap), then run the full
// pixelmatch only on the few best — a pixelmatch per offset took minutes on large frames ((2k+1)^2 runs)
const fr = gray(ref, 1), fn = gray(render, 1);
const cands = [];
for (let oy = Math.max(0, coarse.oy * k - k); oy <= Math.min(Math.max(0, ref.height - h), coarse.oy * k + k); oy++)
  for (let ox = Math.max(0, coarse.ox * k - k); ox <= Math.min(Math.max(0, ref.width - w), coarse.ox * k + k); ox++) {
    let e = 0;
    for (let y = 0; y < Math.min(fn.H, fr.H - oy); y += 2) for (let x = 0; x < Math.min(fn.W, fr.W - ox); x += 2) e += Math.abs(fr.d[(y + oy) * fr.W + x + ox] - fn.d[y * fn.W + x]);
    cands.push({ e, ox, oy });
  }
let best = null;
for (const { ox, oy } of cands.sort((a, b) => a.e - b.e).slice(0, 3)) {
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
