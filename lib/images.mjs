// Signed download URLs of image fills, the way the web editor gets them: POST /file/<key>/image/batch with the
// figma.com session of refigma's headless Edge (~0.3s, no REST quota, no Figma token, no page to render).
//   node images.mjs <fileKey> <sha1>...      -> prints {"<sha1>": "<signed url>", ...}
import { ensure, cdp } from './browser.mjs';
import { UA } from './env.mjs';

const [fileKey, ...hashes] = process.argv.slice(2);
if (!/^[A-Za-z0-9]+$/.test(fileKey || '') || !hashes.every(h => /^[0-9a-f]{40}$/.test(h))) {
  console.error('usage: images.mjs <fileKey> <sha1>...'); process.exit(64);
}
const port = await ensure();
const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const b = await cdp(v.webSocketDebuggerUrl);
const { cookies } = await b.call('Storage.getCookies'); b.close();
const jar = cookies.filter(c => /(^|\.)figma\.com$/.test(c.domain)).map(c => `${c.name}=${c.value}`).join('; ');
const urls = {};
for (let i = 0; i < hashes.length; i += 200) {   // the editor asks ~30 at a time; keep each request small
  const r = await fetch(`https://www.figma.com/file/${fileKey}/image/batch`, {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Csrf-Bypass': 'yes', 'User-Agent': UA, Cookie: jar },
    body: JSON.stringify({ sha1s: hashes.slice(i, i + 200) }) });
  if (!r.ok) { console.error(`image/batch ${r.status}: ${(await r.text()).slice(0, 120).trim()}`); process.exit(r.status === 403 ? 3 : 1); }
  Object.assign(urls, (await r.json()).meta?.s3_urls || {});
}
console.log(JSON.stringify(urls));
process.exit(0);
