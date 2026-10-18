/**
 * What the E2E config and the spec share: where the app, its clip and the WebDriver servers are,
 * and a look at the app's processes (the spec checks that closing the window ends them).
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The app under test: a debug build with the UI inside (`npm run e2e:build`). A plain
 * `cargo build -p kaleido` makes a dev build instead, which loads the UI from Vite's dev server.
 */
export const APP = path.join(ROOT, 'target', 'debug', 'Kaleido.exe');

/** The clip `e2e/make-media.ps1` writes. */
export const CLIP = path.join(ROOT, 'e2e', 'media', 'kaleido-e2e.mkv');

/** Microsoft Edge WebDriver in the WebView2 runtime's version (`e2e/fetch-driver.ps1`). */
export const EDGE_DRIVER =
  process.env['KALEIDO_EDGE_DRIVER'] ?? path.join(ROOT, 'e2e', 'driver', 'msedgedriver.exe');

/** Where `cargo install tauri-driver --locked` puts it. */
export const TAURI_DRIVER =
  process.env['KALEIDO_TAURI_DRIVER'] ?? path.join(os.homedir(), '.cargo', 'bin', 'tauri-driver.exe');

export interface AppProcess {
  pid: number;
  parent: number;
  name: string;
  path: string;
}

/** Every running `Kaleido.exe` and `kaleido-mpv.exe`, whichever build. */
export function kaleidoProcesses(): AppProcess[] {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name = 'Kaleido.exe' or Name = 'kaleido-mpv.exe'\" | " +
    'ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; ' +
    'name = $_.Name; path = [string]$_.ExecutablePath } } | ConvertTo-Json -Compress';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  }).trim();
  if (out === '') return [];
  const parsed = JSON.parse(out) as AppProcess | AppProcess[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** The running `Kaleido.exe` of `APP` and the `kaleido-mpv.exe` helpers it started. */
export function appProcesses(): AppProcess[] {
  const all = kaleidoProcesses();
  const apps = all.filter((p) => p.path.toLowerCase() === APP.toLowerCase());
  const ids = new Set(apps.map((p) => p.pid));
  return [...apps, ...all.filter((p) => p.name.toLowerCase() === 'kaleido-mpv.exe' && ids.has(p.parent))];
}

/** Whether the process still runs (signal 0 only asks; ESRCH = it has ended). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
