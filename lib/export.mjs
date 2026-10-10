// Export a node of a captured frame as PNG / JPG / PDF at any scale, rendered from the verified index.html.
// usage: node export.mjs <capture dir> <node id | "root"> <png|jpg|pdf> <scale> <out file> [--transparent]
import fs from 'node:fs';
import path from 'node:path';
import { openPage } from './headless.mjs';

const [dir, nodeId, format, scaleArg, out, flag] = process.argv.slice(2);
const scale = +scaleArg || 2;
const { w, h } = JSON.parse(fs.readFileSync(path.join(dir, 'extract.json'), 'utf8'));
const view = await openPage({ width: w, height: h, scale });
try {
  await view.load(path.join(dir, 'index.html'));
  const sel = nodeId === 'root' ? 'body > div' : `[data-id="${nodeId}"]`;
  const rect = await view.evalv(`(() => { const e = document.querySelector('${sel}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  if (!rect) throw new Error(`node ${nodeId} not found in this capture (use an id from figma_get_node / figma_get_metadata)`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Figma exports a node on its own: hide everything else (ancestors' backgrounds included)
  if (nodeId !== 'root') await view.evalv(`(() => { const st = document.createElement('style');
    st.textContent = 'body * { visibility: hidden !important; } ${sel}, ${sel} * { visibility: visible !important; }'; document.head.append(st); return 1; })()`);
  if (format === 'pdf') {
    // isolate the node on its own page, then print to a page of exactly its size (vector output)
    await view.evalv(`(() => { const e = document.querySelector('${sel}'); const r = e.getBoundingClientRect();
      document.body.style.cssText = 'margin:0;width:${'${'}r.width}px;height:${'${'}r.height}px;overflow:hidden;position:relative';
      const root = document.querySelector('body > div'); root.style.position = 'absolute'; root.style.left = (-r.x) + 'px'; root.style.top = (-r.y) + 'px';
      return 1; })()`);
    const { data } = await view.page.call('Page.printToPDF', { paperWidth: rect.width / 96, paperHeight: rect.height / 96, printBackground: true,
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0, pageRanges: '1', preferCSSPageSize: false });
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
  } else {
    if ((flag === '--transparent' || nodeId !== 'root') && format === 'png') await view.page.call('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const { data } = await view.page.call('Page.captureScreenshot', { format: format === 'jpg' ? 'jpeg' : 'png', quality: format === 'jpg' ? 92 : undefined,
      clip: { ...rect, scale: 1 }, captureBeyondViewport: true });
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
  }
  console.log(JSON.stringify({ out, width: Math.round(rect.width * scale), height: Math.round(rect.height * scale), format, scale }));
} finally { view.close(); }
process.exit(0);
