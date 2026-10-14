// Private headless Edge for rendering: sRGB output (Figma exports sRGB; macOS Edge otherwise renders in the
// display's P3 space) and no extensions. Pages rendered here need no login.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EDGE } from './env.mjs';

export async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = {};
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending[m.id]) pending[m.id](m); };
  await new Promise(r => ws.onopen = r);
  const call = (method, params = {}) => new Promise((res, rej) => { pending[++id] = m => m.error ? rej(new Error(m.error.message)) : res(m.result); ws.send(JSON.stringify({ id, method, params })); });
  return { call, close: () => ws.close() };
}

export async function openPage({ width, height, scale = 1 }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'refigma-render-'));
  // port 0: Edge picks a free port and writes it to DevToolsActivePort, so parallel renders never share a browser
  const proc = spawn(EDGE, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--force-color-profile=srgb',
    '--hide-scrollbars', '--no-first-run', '--disable-extensions', '--font-render-hinting=none', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let done = false;
  const cleanup = () => {   // Edge may still be flushing its profile when killed: never let cleanup throw
    if (done) return; done = true;
    try { proc.kill(); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  };
  process.on('exit', cleanup);
  // a tool timeout kills this process with SIGTERM, which skips 'exit' handlers: never leave Edge running
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, () => { cleanup(); process.exit(128 + os.constants.signals[sig]); });
  let version, port;
  for (let i = 0; i < 60 && !version; i++) {
    try {
      port ||= +fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] || 0;
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  if (!version) { cleanup(); throw new Error('could not start headless Edge'); }
  const browser = await cdp(version.webSocketDebuggerUrl);
  const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank' });
  const page = await cdp(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
  await page.call('Page.enable');
  await page.call('Emulation.setDeviceMetricsOverride', { width: Math.ceil(width), height: Math.ceil(height), deviceScaleFactor: scale, mobile: false });
  const evalv = async e => (await page.call('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
  async function load(url, settle = +(process.env.SETTLE_MS || 400)) {
    await page.call('Page.navigate', { url: /^https?:|^file:/.test(url) ? url : 'file://' + path.resolve(url) });
    for (let i = 0; i < 60; i++) {
      if (await evalv("document.readyState === 'complete' && document.fonts.status === 'loaded' && [...document.images].every(i => i.complete)")) break;
      await new Promise(r => setTimeout(r, 250));
    }
    // extensions are disabled here, but keep pages clean of anything injected after load
    await evalv("if (location.protocol === 'file:') { const st = document.createElement('style'); st.textContent = 'html > :not(head):not(body), body > :not(:first-child):not(script):not(style) { display: none !important; }'; document.head.append(st); } 1");
    await new Promise(r => setTimeout(r, settle));
  }
  const close = () => { page.close(); browser.close(); cleanup(); };
  return { page, evalv, load, close };
}
