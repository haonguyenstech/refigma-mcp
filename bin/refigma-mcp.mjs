#!/usr/bin/env node
// Entry point of the package: runs the newest refigma installed — this copy, or a release lib/update.mjs fetched into
// ~/.figma-local/app/<version>/ — and checks for a newer release in the background. So the MCP config never changes
// on an update; a new release is used from the next start of the server (restart Claude Desktop / reconnect).
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP, installed, cmpVer } from '../lib/update.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const self = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const auto = process.env.REFIGMA_AUTO_UPDATE !== '0';
const newer = auto ? installed().find(v => cmpVer(v, self) > 0) : null;
const dir = newer ? path.join(APP, newer) : ROOT;

if (auto) {
  // the chosen copy's updater, so fixes to it ship like everything else; detached, it never delays the server
  const upd = path.join(dir, 'lib', 'update.mjs');
  try { spawn(process.execPath, [fs.existsSync(upd) ? upd : path.join(ROOT, 'lib', 'update.mjs')], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
}
await import(pathToFileURL(path.join(dir, 'server.mjs')).href);
