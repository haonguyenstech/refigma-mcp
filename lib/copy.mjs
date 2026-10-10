// Hook clipboard writes in the figma.com tab (CDP :9222), press Cmd+C (scene data) and Shift+Cmd+C (PNG), save both.
import fs from 'node:fs';
const outDir = process.argv[2];
const tabs = await (await fetch('http://127.0.0.1:9222/json')).json();
const tab = tabs.find(t => t.type === 'page' && t.url.includes('figma.com/design'));
if (!tab) { console.error('no figma.com/design tab'); process.exit(1); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0; const pending = {};
const call = (method, params = {}) => new Promise(r => { pending[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending[m.id]) pending[m.id](m.result ?? m); };
await new Promise(r => ws.onopen = r);
const evalv = async e => (await call('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
await evalv(`(() => { window.__cap = {};
  const orig = DataTransfer.prototype.setData;
  DataTransfer.prototype.setData = function (t, v) { window.__cap[t] = v; return orig.call(this, t, v); };
  const w = navigator.clipboard.write.bind(navigator.clipboard);
  navigator.clipboard.write = async items => { for (const it of items) for (const t of it.types) {
      const b = await it.getType(t);
      window.__cap[t] = t.startsWith('image/') ? await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); }) : await b.text(); }
    return w(items).catch(() => {}); };
  return 1; })()`);
const key = async (modifiers, cmd) => { for (const type of ['rawKeyDown', 'keyUp'])
  await call('Input.dispatchKeyEvent', { type, modifiers, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, commands: type === 'rawKeyDown' && cmd ? [cmd] : [] }); };
// Scene data: execCommand('copy') with a user gesture fires Figma's copy handler even when the window is hidden
// or occluded (synthetic key events are dropped then). Focus must be on Figma's focus-target, not a text field.
await call('Emulation.setFocusEmulationEnabled', { enabled: true });
// Figma routes shortcuts/clipboard through a hidden <input class="focus-target">, not the canvas.
const focusCanvas = () => evalv(`(() => { const f = document.querySelector('input.focus-target');
  if (f) f.focus(); else document.activeElement?.blur?.(); return document.activeElement?.className; })()`);
const read = async () => JSON.parse(await evalv('JSON.stringify(window.__cap)') || '{}');
for (let i = 0; i < 4 && !(await read())['text/html']; i++) {
  await focusCanvas();
  await call('Runtime.evaluate', { expression: "document.execCommand('copy')", userGesture: true });
  await new Promise(r => setTimeout(r, 1500 + i * 1500));
}
// PNG: only reachable through the Shift+Cmd+C shortcut; best effort (needs the debug window visible).
if ((await read())['text/html']) {
  await call('Page.bringToFront'); await focusCanvas(); await key(4 | 8);
  for (let i = 0; i < 16 && !(await read())['image/png']; i++) await new Promise(r => setTimeout(r, 500));
}
const cap = await read();
if (!cap['text/html']) { console.error('no figma data captured (is a node selected?)'); process.exit(2); }
fs.writeFileSync(`${outDir}/clip.html`, cap['text/html']);
if (!cap['image/png']) console.error('warning: PNG not captured (debug Edge window hidden?)');
if (cap['image/png']) fs.writeFileSync(`${outDir}/frame.png`, Buffer.from(cap['image/png'].split(',')[1], 'base64'));
console.log('captured', Object.keys(cap).join(','));
process.exit(0);
