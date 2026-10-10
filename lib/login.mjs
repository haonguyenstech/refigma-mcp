// Copy the figma.com session from the user's real Edge into the debug Edge (:9222), then verify it.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cookies = JSON.parse(execFileSync('python3', [path.join(here, 'cookies.py')], { encoding: 'utf8' }));
if (!cookies.some(c => c.name === '__Host-figma.authn')) { console.error('the real Edge profile has no figma.com login — sign in to figma.com in Edge first'); process.exit(2); }
const v = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const ws = new WebSocket(v.webSocketDebuggerUrl); let id = 0; const pending = {};
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending[m.id]) pending[m.id](m); };
await new Promise(r => ws.onopen = r);
const call = (method, params = {}) => new Promise((res, rej) => { pending[++id] = m => m.error ? rej(new Error(m.error.message)) : res(m.result); ws.send(JSON.stringify({ id, method, params })); });
await call('Storage.setCookies', { cookies });
// verify from a figma.com page context
const tabs = await (await fetch('http://127.0.0.1:9222/json')).json();
let tab = tabs.find(t => t.type === 'page' && t.url.includes('figma.com'));
const page = new WebSocket((tab || tabs.find(t => t.type === 'page')).webSocketDebuggerUrl); let pid = 0; const pp = {};
page.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pp[m.id]) pp[m.id](m.result); };
await new Promise(r => page.onopen = r);
const pcall = (method, params = {}) => new Promise(r => { pp[++pid] = r; page.send(JSON.stringify({ id: pid, method, params })); });
if (!tab) { await pcall('Page.navigate', { url: 'https://www.figma.com/robots.txt' }); await new Promise(r => setTimeout(r, 2500)); }
const r = await pcall('Runtime.evaluate', { expression: "fetch('/api/user/state',{credentials:'include'}).then(r=>r.json()).then(j=>j.meta?.users?.[0]?.email || j.meta?.user?.email || (j.error===false?'ok':'signed out'))", awaitPromise: true, returnByValue: true });
const expiry = cookies.find(c => c.name === '__Host-figma.authn')?.expires;
console.log(JSON.stringify({ imported: cookies.length, session: r.result.value, expires: expiry ? new Date(expiry * 1000).toISOString().slice(0, 10) : null }));
process.exit(0);
