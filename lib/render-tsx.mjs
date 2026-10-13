// Render a generated React+Tailwind component to an HTML page (Tailwind via the Play CDN) so figma_compare can diff it.
// usage: node render-tsx.mjs <Component.tsx> <out.html>
// The component is generated from design content, so it is only transpiled here, never run in Node: the page renders it
// in the sandboxed headless browser with the local React UMD builds.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';

const [src, out] = process.argv.slice(2);
const code = fs.readFileSync(src, 'utf8');
const js = transformSync(code, { loader: 'tsx', format: 'iife', globalName: '__Component', jsx: 'transform', jsxFactory: 'React.createElement' }).code;
const require = createRequire(import.meta.url);
const umd = (pkg, f) => pathToFileURL(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'umd', f)).href;
const fonts = code.match(/\/\/ Fonts: (https:\/\/fonts\.googleapis\.com\/\S+)/)?.[1];
const attr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
fs.writeFileSync(out, `<!doctype html><html><head><meta charset="utf-8">
${fonts ? `<link rel="stylesheet" href="${attr(fonts)}">` : ''}
<script src="https://cdn.tailwindcss.com/3.4.17"></script>
<script src="${umd('react', 'react.production.min.js')}"></script>
<script src="${umd('react-dom', 'react-dom.production.min.js')}"></script>
<style>body{margin:0;background:transparent}#root{display:contents}</style></head><body><div id="root"></div>
<script>${js.replace(/<\/script/gi, '<\\/script')}
ReactDOM.flushSync(() => ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(__Component.default)));</script>
</body></html>`);
console.log(out);
