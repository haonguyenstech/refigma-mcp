// The browser refigma drives: a private *headless* Edge (no window, nothing on screen) with its own persistent
// profile, started on demand and left running in the background for fast follow-up captures.
// The figma.com session is copied in from the debug Edge (:9222) if it runs, else from the real Edge profile.
//   node browser.mjs ensure     -> prints the CDP port once the headless browser is up and logged in
//   node browser.mjs stop
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PORT = +(process.env.REFIGMA_PORT || 9334);
const EDGE = process.env.REFIGMA_BROWSER || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PROFILE = path.join(os.homedir(), '.figma-local', 'headless-profile');
// A browser-like UA: Figma's CDN rejects "HeadlessChrome".
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const here = path.dirname(fileURLToPath(import.meta.url));

const alive = async port => { try { return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { return null; } };

export async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = {};
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending[m.id]) pending[m.id](m); };
  await new Promise(r => ws.onopen = r);
  const call = (method, params = {}) => new Promise((res, rej) => { pending[++id] = m => m.error ? rej(new Error(m.error.message)) : res(m.result); ws.send(JSON.stringify({ id, method, params })); });
  return { call, close: () => ws.close() };
}

async function figmaCookies(fromRealEdge = false) {
  const dbg = !fromRealEdge && await alive(9222);
  if (dbg) {   // the debug Edge is already logged in: no Keychain prompt needed
    const b = await cdp(dbg.webSocketDebuggerUrl);
    const { cookies } = await b.call('Storage.getCookies'); b.close();
    const fig = cookies.filter(c => c.domain.includes('figma.com'));
    if (fig.some(c => c.name === '__Host-figma.authn')) return fig.map(({ size, session, priority, sourceScheme, sourcePort, partitionKey, ...c }) => c);
  }
  return JSON.parse(execFileSync('python3', [path.join(here, 'cookies.py')], { encoding: 'utf8' }));
}

export async function importSession(port = PORT, fromRealEdge = false) {
  const v = await alive(port);
  const b = await cdp(v.webSocketDebuggerUrl);
  const cookies = await figmaCookies(fromRealEdge);
  if (!cookies.some(c => c.name === '__Host-figma.authn')) throw new Error('no figma.com login found in Edge — sign in to figma.com in Microsoft Edge first');
  await b.call('Storage.setCookies', { cookies }); b.close();
  return cookies.length;
}

export async function ensure() {
  let v = await alive(PORT);
  if (!v) {
    fs.mkdirSync(PROFILE, { recursive: true });
    const p = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, `--user-agent=${UA}`,
      '--disable-blink-features=AutomationControlled', '--window-size=1600,1000', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', 'about:blank'], { stdio: 'ignore', detached: true });
    p.unref();
    for (let i = 0; i < 60 && !v; i++) { v = await alive(PORT); if (!v) await new Promise(r => setTimeout(r, 200)); }
    if (!v) throw new Error('could not start headless Edge');
  }
  const b = await cdp(v.webSocketDebuggerUrl);
  const { cookies } = await b.call('Storage.getCookies'); b.close();
  if (!cookies.some(c => c.name === '__Host-figma.authn' && (!c.expires || c.expires < 0 || c.expires * 1000 > Date.now()))) await importSession();
  return PORT;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'ensure') { console.log(await ensure()); process.exit(0); }
  if (cmd === 'relogin') {   // always from the real Edge profile: it holds the freshest session
    await ensure();
    const n = await importSession(PORT, true);
    const v = await alive(PORT); const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const pg = await cdp(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await pg.call('Page.navigate', { url: 'https://www.figma.com/robots.txt' }); await new Promise(r => setTimeout(r, 2000));
    const r = await pg.call('Runtime.evaluate', { expression: "fetch('/api/user/state',{credentials:'include'}).then(r=>r.json()).then(j=>j.error===false?'ok':'signed out')", awaitPromise: true, returnByValue: true });
    console.log(JSON.stringify({ imported: n, session: r.result.value, browser: v.Browser })); process.exit(0);
  }
  if (cmd === 'stop') { const v = await alive(PORT); if (v) { const b = await cdp(v.webSocketDebuggerUrl); await b.call('Browser.close').catch(() => {}); } console.log('stopped'); process.exit(0); }
}
