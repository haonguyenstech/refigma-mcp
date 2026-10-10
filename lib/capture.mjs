// One CDP session on the logged-in debug Edge (:9222):
//   - blocks FigmaAgent (127.0.0.1:44950) so Figma Desktop does not pop up and the web editor opens directly
//   - records the multiplayer WebSocket (fig-wire schema + NODE_CHANGES = the whole loaded page) into <docDir>
//   - optionally copies the selected node (Figma's copy handler -> fig-kiwi HTML) and its PNG into <outDir>
// usage: node capture.mjs <figma url> <docDir> [outDir]     (no outDir = document only)
import fs from 'node:fs';
import path from 'node:path';

const [url, docDir, outDir] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

let tabs = await (await fetch('http://127.0.0.1:9222/json')).json();
let tab = tabs.find(t => t.type === 'page' && t.url.includes('figma.com')) || tabs.find(t => t.type === 'page');
if (!tab) {
  await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' });
  tabs = await (await fetch('http://127.0.0.1:9222/json')).json();
  tab = tabs.find(t => t.type === 'page');
}
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0; const pending = {};
const call = (method, params = {}, sessionId) => new Promise(r => { pending[++id] = r; ws.send(JSON.stringify({ id, method, params, sessionId })); });
const evalv = async e => (await call('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;

const BLOCK = ['http://127.0.0.1:449*', 'http://localhost:449*', 'figma:*'];
const sockets = {};            // requestId -> url (multiplayer only)
const frames = [];             // raw binary frames of the multiplayer socket
let joined = false;
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending[m.id]) return pending[m.id](m.result ?? m);
  const sid = m.sessionId;
  if (m.method === 'Target.attachedToTarget') {
    const s = m.params.sessionId;
    call('Network.enable', { maxTotalBufferSize: 500e6, maxResourceBufferSize: 300e6 }, s);
    call('Network.setBlockedURLs', { urls: BLOCK }, s);
    call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, s);
    call('Runtime.runIfWaitingForDebugger', {}, s);
  }
  if (m.method === 'Network.webSocketCreated' && m.params.url.includes('/api/multiplayer/')) sockets[m.params.requestId] = m.params.url;
  if (m.method === 'Network.webSocketFrameReceived' && sockets[m.params.requestId] && m.params.response.opcode === 2) {
    const b = Buffer.from(m.params.response.payloadData, 'base64');
    frames.push(b);
    if (b.length < 4096 && frames.length > 2) joined = true;   // small control frames follow the big NODE_CHANGES
  }
  void sid;
};
await new Promise(r => ws.onopen = r);
await call('Page.enable');
await call('Network.enable', { maxTotalBufferSize: 500e6, maxResourceBufferSize: 300e6 });
await call('Network.setBlockedURLs', { urls: BLOCK });
await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await call('Emulation.setFocusEmulationEnabled', { enabled: true });

const u = new URL(url);
const nodeId = u.searchParams.get('node-id');
const target = `${u.origin}${u.pathname}${nodeId ? `?node-id=${nodeId}` : ''}`;
await call('Page.navigate', { url: target });

// wait for the editor + the document snapshot
let state = '';
for (let i = 0; i < 90; i++) {
  state = await evalv(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Open here instead'));
    if (b) { b.click(); return 'clicked'; }
    if (/sign in|log in/i.test(document.title) || location.pathname.startsWith('/login')) return 'login';
    return document.querySelector('canvas') ? 'canvas' : 'wait'; })()`).catch(() => 'wait');
  if (state === 'login') die('NOT_LOGGED_IN: figma.com shows the login page in the debug Edge — run figma_relogin', 3);
  if (state === 'canvas' && joined) break;
  await sleep(1000);
}
if (state !== 'canvas') die('editor did not load (logged out? run figma_relogin)');
for (let i = 0; i < 10 && !joined; i++) await sleep(500);

// persist the document frames: schema frame (starts with "fig-wire") + the rest
fs.mkdirSync(docDir, { recursive: true });
const schemaIdx = frames.findIndex(b => b.subarray(0, 8).toString() === 'fig-wire');
if (schemaIdx >= 0) {
  fs.writeFileSync(path.join(docDir, 'schema.bin'), frames[schemaIdx]);
  const big = frames.filter((b, i) => i !== schemaIdx && b.length > 4096);
  fs.writeFileSync(path.join(docDir, 'frames.json'), JSON.stringify(big.map((_, i) => `f${i}.bin`)));
  big.forEach((b, i) => fs.writeFileSync(path.join(docDir, `f${i}.bin`), b));
  fs.writeFileSync(path.join(docDir, 'meta.json'), JSON.stringify({ url: target, at: new Date().toISOString() }));
} else console.error('warning: multiplayer document not captured');

if (!outDir) { console.log('doc captured', frames.length, 'frames'); process.exit(0); }

// ---- copy the selected node
fs.mkdirSync(outDir, { recursive: true });
await sleep(4000);   // let selection from ?node-id settle
await evalv(`(() => { window.__cap = {};
  const orig = DataTransfer.prototype.setData;
  if (!DataTransfer.prototype.__hooked) { DataTransfer.prototype.__hooked = true;
    DataTransfer.prototype.setData = function (t, v) { (window.__cap ||= {})[t] = v; return orig.call(this, t, v); }; }
  if (!navigator.clipboard.__hooked) { const w = navigator.clipboard.write.bind(navigator.clipboard); navigator.clipboard.__hooked = true;
    navigator.clipboard.write = async items => { for (const it of items) for (const t of it.types) { const b = await it.getType(t);
      window.__cap[t] = t.startsWith('image/') ? await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); }) : await b.text(); }
      return w(items).catch(() => {}); }; }
  return 1; })()`);
// Figma routes shortcuts/clipboard through a hidden <input class="focus-target">, not the canvas.
const focus = () => evalv(`(() => { const f = document.querySelector('input.focus-target'); if (f) f.focus(); else document.activeElement?.blur?.(); return 1; })()`);
const cap = async () => JSON.parse(await evalv('JSON.stringify(window.__cap || {})') || '{}');
// execCommand('copy') with a user gesture fires Figma's copy handler even if the window is hidden (key events are dropped then)
for (let i = 0; i < 5 && !(await cap())['text/html']; i++) {
  await focus();
  await call('Runtime.evaluate', { expression: "document.execCommand('copy')", userGesture: true });
  await sleep(1500 + i * 1500);
}
let c = await cap();
if (!c['text/html']) die('no figma data captured (is the node id valid / visible on this page?)', 2);
// PNG: only via the Shift+Cmd+C shortcut (needs the debug window visible) — best effort
await call('Page.bringToFront'); await focus();
for (const type of ['rawKeyDown', 'keyUp'])
  await call('Input.dispatchKeyEvent', { type, modifiers: 4 | 8, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
for (let i = 0; i < 16 && !(await cap())['image/png']; i++) await sleep(500);
c = await cap();
fs.writeFileSync(path.join(outDir, 'clip.html'), c['text/html']);
if (c['image/png']) fs.writeFileSync(path.join(outDir, 'frame.png'), Buffer.from(c['image/png'].split(',')[1], 'base64'));
else console.error('warning: PNG not captured (debug Edge window hidden?)');
console.log('captured', Object.keys(c).join(','));
process.exit(0);
