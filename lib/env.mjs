// What differs between macOS and Windows: where Edge lives, how Python is called, the browser's identity and
// the copy-as-PNG shortcut. Everything else is the same code on both.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const IS_WIN = process.platform === 'win32';

function findEdge() {
  if (process.env.REFIGMA_BROWSER) return process.env.REFIGMA_BROWSER;
  if (!IS_WIN) return '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  const exe = path.join('Microsoft', 'Edge', 'Application', 'msedge.exe');
  const dirs = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  return dirs.map(d => path.join(d, exe)).find(f => fs.existsSync(f)) || path.join(dirs[0] || 'C:\\Program Files (x86)', exe);
}
export const EDGE = findEdge();

// [command, ...args] of a working Python 3. Windows' "python" can be the Microsoft Store stub, so each candidate is tried.
let python;
export function pythonCmd() {
  if (python) return python;
  const env = process.env.REFIGMA_PYTHON;
  const candidates = env ? [[env]] : IS_WIN ? [['python'], ['py', '-3'], ['python3']] : [['python3']];
  python = candidates.find(([c, ...a]) => spawnSync(c, [...a, '-c', 'import sys; assert sys.version_info >= (3, 8)'], { stdio: 'ignore', windowsHide: true }).status === 0);
  if (!python) throw new Error(`Python 3 not found (tried ${candidates.map(c => c.join(' ')).join(', ')}) — install it${IS_WIN ? ' (winget install Python.Python.3.12)' : ''} or set REFIGMA_PYTHON`);
  return python;
}
// UTF-8 for Python's files and stdout: Windows defaults to the ANSI code page and fails on non-Latin layer names.
export const PYTHON_ENV = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };

// A browser-like UA that matches the real platform (Figma's CDN rejects "HeadlessChrome"; Figma picks shortcuts by platform).
export const UA = IS_WIN
  ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0'
  : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';

// Copy as PNG: Shift+Cmd+C on macOS, Shift+Ctrl+C on Windows (CDP modifiers: 2 Ctrl, 4 Meta, 8 Shift).
export const COPY_PNG_MODIFIERS = (IS_WIN ? 2 : 4) | 8;
