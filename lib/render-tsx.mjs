// Render a generated React+Tailwind component to static HTML (Tailwind via the Play CDN) so figma_compare can diff it.
// usage: node render-tsx.mjs <Component.tsx> <out.html>
import fs from 'node:fs';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const [src, out] = process.argv.slice(2);
const code = fs.readFileSync(src, 'utf8');
// CommonJS + an injected React: the generated file has no imports, so no module resolution is needed.
const js = transformSync(code, { loader: 'tsx', format: 'cjs', jsx: 'transform', jsxFactory: 'React.createElement' }).code;
const module = { exports: {} };
new Function('React', 'module', 'exports', js)(React, module, module.exports);
const mod = module.exports;
const fonts = code.match(/\/\/ Fonts: (\S+)/)?.[1];
const markup = renderToStaticMarkup(React.createElement(mod.default));
fs.writeFileSync(out, `<!doctype html><html><head><meta charset="utf-8">
${fonts && fonts !== 'none' ? `<link rel="stylesheet" href="${fonts}">` : ''}
<script src="https://cdn.tailwindcss.com/3.4.17"></script>
<style>body{margin:0;background:transparent}</style></head><body>${markup}</body></html>`);
console.log(out);
