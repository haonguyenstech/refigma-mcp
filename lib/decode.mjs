// Decode Figma clipboard HTML (figmeta + fig-kiwi) into a JSON message.
import fs from 'node:fs';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { decompress as zstd } from 'fzstd';
import * as pako from 'pako';
const html = fs.readFileSync(process.argv[2], 'utf8');
const meta = html.match(/\(figmeta\)([A-Za-z0-9+/=]+)\(\/figmeta\)/);
if (meta) console.log('meta:', Buffer.from(meta[1], 'base64').toString());
const b64 = html.match(/\(figma\)([A-Za-z0-9+/=]+)\(\/figma\)/)[1];
const buf = new Uint8Array(Buffer.from(b64, 'base64'));
const dv = new DataView(buf.buffer, buf.byteOffset);
console.log('magic:', Buffer.from(buf.slice(0, 8)).toString(), 'ver:', dv.getUint32(8, true));
let off = 12; const chunks = [];
while (off < buf.length) { const len = dv.getUint32(off, true); off += 4; chunks.push(buf.slice(off, off + len)); off += len; }
const inflate = c => (c[0] === 0x28 && c[1] === 0xb5 && c[2] === 0x2f && c[3] === 0xfd) ? zstd(c) : pako.inflateRaw(c);
const schema = compileSchema(decodeBinarySchema(inflate(chunks[0])));
const msg = schema.decodeMessage(inflate(chunks[1]));
const replacer = (k, v) => (v instanceof Uint8Array ? `<bytes ${v.length}>` : typeof v === 'bigint' ? Number(v) : v);
fs.writeFileSync(process.argv[3], JSON.stringify(msg, replacer));
console.log('nodeChanges:', msg.nodeChanges?.length, 'blobs:', msg.blobs?.length, 'keys:', Object.keys(msg).join(','));
