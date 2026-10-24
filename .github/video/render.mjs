// Renders a scene page frame by frame (deterministic, crisp text) into a setup video, with an optional voice-over.
//   node render.mjs <page> stills 5 12 20 ...   -> out/<page>-<t>.png, to check scenes
//   node render.mjs <page> video                -> ../assets/<name>.mp4 (+ .gif)
// Pages: setup (macOS, silent, also a GIF) · windows (voice from out/win-*.wav, made by narrate.py)
// Needs Playwright (PLAYWRIGHT=path to playwright/index.mjs) and ffmpeg.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const [pageName, mode = 'stills', ...args] = process.argv.slice(2);
const CFG = {
  setup: { name: 'claude-desktop-setup', gif: true },
  // music: out/music-inspired.mp3 = "Inspired", Kevin MacLeod (incompetech.com), CC BY 4.0 — credited on the end card
  windows: { name: 'claude-desktop-windows-setup', vo: 'win', music: 'music-inspired.mp3' },
}[pageName];
if (!CFG) { console.error('usage: render.mjs <setup|windows> <stills t...|video>'); process.exit(64); }
const out = path.join(dir, 'out'); fs.mkdirSync(out, { recursive: true });
const FPS = 30, DPR = 1.2;
const voFile = CFG.vo && path.join(out, `${CFG.vo}.json`);
const vo = voFile && fs.existsSync(voFile) ? JSON.parse(fs.readFileSync(voFile, 'utf8')) : null;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: DPR })).newPage();
if (vo) await page.addInitScript(d => { window.VO = d; }, vo.map(v => v.dur));   // scene lengths follow the narration
await page.goto('file://' + path.join(dir, `${pageName}.html`));
await page.evaluate(() => window.ready);
const T = await page.evaluate(() => T);

if (mode === 'stills') {
  for (const t of args.map(Number)) {
    await page.evaluate(t => render(t), t);
    await page.screenshot({ path: path.join(out, `${pageName}-${t}.png`) });
  }
} else {
  const assets = path.join(dir, '..', 'assets');
  const mp4 = path.join(assets, `${CFG.name}.mp4`), silent = vo ? path.join(out, `${CFG.name}-silent.mp4`) : mp4;
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', silent], { stdio: ['pipe', 'inherit', 'inherit'] });
  const n = Math.round(T * FPS);
  for (let i = 0; i < n; i++) {
    await page.evaluate(t => render(t), i / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 300 === 0) process.stdout.write(`${(i / FPS).toFixed(0)}s `);
  }
  ff.stdin.end(); await new Promise(r => ff.on('close', r));
  if (vo) {
    // each line starts where the page says its scene does; mixed without normalizing, then loudness-matched to -16 LUFS
    const starts = await page.evaluate(() => window.VO_STARTS);
    const ins = vo.flatMap(v => ['-i', path.join(out, `${CFG.vo}-${v.i}.wav`)]);
    let fil = vo.map((v, k) => `[${k + 1}:a]adelay=${Math.round(starts[k] * 1000)}:all=1,aresample=48000[a${k}]`).join(';') +
      `;${vo.map((_, k) => `[a${k}]`).join('')}amix=inputs=${vo.length}:normalize=0,apad=whole_dur=${T}`;   // full length: the sidechain stops with its key
    const music = CFG.music && path.join(out, CFG.music);
    if (music && fs.existsSync(music)) {
      // a quiet bed under the voice, ducked further while it speaks (sidechain), faded in and out
      ins.push('-i', music);
      fil += `,asplit[voice][key];[${vo.length + 1}:a]atrim=0:${T},asetpts=N/SR/TB,aresample=48000,aformat=channel_layouts=stereo,volume=0.16,` +
        `afade=t=in:d=1.5,afade=t=out:st=${(T - 3.5).toFixed(2)}:d=3.5[bed];[bed][key]sidechaincompress=threshold=0.02:ratio=4:attack=30:release=600[duck];` +
        `[voice][duck]amix=inputs=2:normalize=0`;
    } else if (music) console.warn(`no ${music}: rendering without music`);
    fil += ',loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]';
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', silent, ...ins, '-filter_complex', fil, '-map', '0:v', '-map', '[a]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-t', String(T), '-movflags', '+faststart', mp4], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(1);
  }
  if (CFG.gif) {   // README GIF: smaller, 10 fps, shared palette
    const gif = path.join(assets, `${CFG.name}.gif`);
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf',
      'fps=10,scale=860:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif], { stdio: 'inherit' });
    console.log(`\n${gif} ${(fs.statSync(gif).size / 1e6).toFixed(1)} MB`);
  }
  console.log(`\n${mp4} ${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB, ${T.toFixed(1)} s`);
}
await browser.close();
