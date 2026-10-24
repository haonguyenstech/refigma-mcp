// Renders setup.html frame by frame (deterministic, crisp text) into the Claude Desktop setup video + GIF.
//   node render.mjs stills 5 12 20 ...     -> out/still-<t>.png, to check scenes
//   node render.mjs video                  -> ../assets/claude-desktop-setup.mp4 + .gif
// Needs Playwright (PLAYWRIGHT=path to playwright/index.mjs) and ffmpeg.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const [mode = 'stills', ...args] = process.argv.slice(2);
const out = path.join(dir, 'out'); fs.mkdirSync(out, { recursive: true });
const FPS = 30, DPR = 1.2;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: DPR })).newPage();
await page.goto('file://' + path.join(dir, 'setup.html'));
await page.evaluate(() => window.ready);
const T = await page.evaluate(() => T);

if (mode === 'stills') {
  for (const t of args.map(Number)) {
    await page.evaluate(t => render(t), t);
    await page.screenshot({ path: path.join(out, `still-${t}.png`) });
  }
} else {
  const assets = path.join(dir, '..', 'assets');
  const mp4 = path.join(assets, 'claude-desktop-setup.mp4');
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: ['pipe', 'inherit', 'inherit'] });
  const n = Math.round(T * FPS);
  for (let i = 0; i < n; i++) {
    await page.evaluate(t => render(t), i / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 150 === 0) process.stdout.write(`${(i / FPS).toFixed(0)}s `);
  }
  ff.stdin.end(); await new Promise(r => ff.on('close', r));
  // README GIF: smaller, 10 fps, shared palette
  const gif = path.join(assets, 'claude-desktop-setup.gif');
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf',
    'fps=10,scale=860:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif], { stdio: 'inherit' });
  console.log(`\n${mp4} ${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB\n${gif} ${(fs.statSync(gif).size / 1e6).toFixed(1)} MB`);
}
await browser.close();
