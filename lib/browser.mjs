// The browser refigma drives: a private *headless* Edge (no window, nothing on screen) with its own persistent
// profile, started on demand and left running in the background for fast follow-up captures.
// The figma.com session is copied in from the debug Edge (:9222) if it runs, else from the real Edge profile (macOS).
// On Windows the real profile cannot be read (cookies are app-bound encrypted and locked while Edge runs), so
// `relogin` opens refigma's own profile in a visible Edge window once for the user to sign in; the profile keeps it.
//   node browser.mjs ensure     -> prints the CDP port once the headless browser is up and logged in
//   node browser.mjs relogin
//   node browser.mjs stop
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PORT = +(process.env.REFIGMA_PORT || 9334);
import { EDGE, UA, IS_WIN, pythonCmd } from './env.mjs';

const PROFILE = path.join(os.homedir(), '.figma-local', 'headless-profile');
const AUTH = '__Host-figma.authn';
const LOGIN_TIMEOUT = +(process.env.REFIGMA_LOGIN_TIMEOUT || 300) * 1000;
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
    const fig = cookies.filter(c => /(^|\.)figma\.com$/.test(c.domain));
    if (fig.some(c => c.name === AUTH)) return fig.map(({ size, session, priority, sourceScheme, sourcePort, partitionKey, ...c }) => c);
  }
  if (IS_WIN) return [];   // nothing readable: the caller asks for a sign-in (relogin)
  const [py, ...pyArgs] = pythonCmd();
  return JSON.parse(execFileSync(py, [...pyArgs, path.join(here, 'cookies.py')], { encoding: 'utf8' }));
}

export async function importSession(port = PORT, fromRealEdge = false) {
  const v = await alive(port);
  const b = await cdp(v.webSocketDebuggerUrl);
  const cookies = await figmaCookies(fromRealEdge);
  if (!cookies.some(c => c.name === AUTH)) throw new Error(IS_WIN
    ? 'NOT_LOGGED_IN: refigma has no figma.com session yet — run figma_relogin and sign in in the Edge window it opens'
    : 'no figma.com login found in Edge — sign in to figma.com in Microsoft Edge first');
  await b.call('Storage.setCookies', { cookies }); b.close();
  return cookies.length;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const loggedIn = cookies => cookies.some(c => c.name === AUTH && (!c.expires || c.expires < 0 || c.expires * 1000 > Date.now()));

async function launch({ headless = true, url = 'about:blank' } = {}) {
  fs.mkdirSync(PROFILE, { recursive: true });
  const p = spawn(EDGE, [...(headless ? ['--headless=new'] : []), `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, `--user-agent=${UA}`,
    '--disable-blink-features=AutomationControlled', '--window-size=1600,1000', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', url], { stdio: 'ignore', detached: true, windowsHide: headless });
  p.unref();
  let v = null;
  for (let i = 0; i < 60 && !v; i++) { v = await alive(PORT); if (!v) await sleep(200); }
  if (!v) throw new Error(`could not start Edge (${EDGE})`);
  return v;
}

async function stop() {
  const v = await alive(PORT);
  if (!v) return;
  const b = await cdp(v.webSocketDebuggerUrl); await b.call('Browser.close').catch(() => {}); b.close();
  for (let i = 0; i < 50 && await alive(PORT); i++) await sleep(200);
  await sleep(500);   // the profile lock goes a moment after the port
}

async function browserCookies(v) {
  const b = await cdp(v.webSocketDebuggerUrl);
  const { cookies } = await b.call('Storage.getCookies'); b.close();
  return cookies;
}

export async function ensure() {
  const v = await alive(PORT) || await launch();
  if (!loggedIn(await browserCookies(v))) await importSession();
  return PORT;
}

// Windows: a visible Edge on refigma's profile, open at the login page until the session cookie appears.
async function interactiveLogin() {
  await stop();
  let v = await launch({ headless: false, url: 'https://www.figma.com/login' });
  for (const end = Date.now() + LOGIN_TIMEOUT; !loggedIn(await browserCookies(v)); ) {
    if (Date.now() > end) { await stop(); throw new Error(`NOT_LOGGED_IN: no figma.com sign-in within ${LOGIN_TIMEOUT / 1000}s`); }
    await sleep(1000);
    v = await alive(PORT);
    if (!v) throw new Error('NOT_LOGGED_IN: the sign-in window was closed before figma.com signed in');
  }
  await sleep(1500);   // let Figma finish its redirects so every cookie is written
  await stop();
  await launch();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'ensure') { console.log(await ensure()); process.exit(0); }
  if (cmd === 'relogin') {   // macOS: always from the real Edge profile, it holds the freshest session
    let n;
    if (IS_WIN) { await interactiveLogin(); n = (await browserCookies(await alive(PORT))).filter(c => /figma\.com$/.test(c.domain)).length; }
    else { if (!await alive(PORT)) await launch(); n = await importSession(PORT, true); }
    const v = await alive(PORT); const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const pg = await cdp(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await pg.call('Page.navigate', { url: 'https://www.figma.com/robots.txt' }); await new Promise(r => setTimeout(r, 2000));
    const r = await pg.call('Runtime.evaluate', { expression: "fetch('/api/user/state',{credentials:'include'}).then(r=>r.json()).then(j=>j.error===false?'ok':'signed out')", awaitPromise: true, returnByValue: true });
    console.log(JSON.stringify({ imported: n, session: r.result.value, browser: v.Browser })); process.exit(0);
  }
  if (cmd === 'stop') { await stop(); console.log('stopped'); process.exit(0); }
}
