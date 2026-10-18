/**
 * What the E2E config and the spec share: where the app, its clip and the WebDriver servers are,
 * and a look at the app's processes (the spec checks that closing the window ends them).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
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

/**
 * What mpv saved for the clip when an earlier run, or a session of the user's with the clip, ended
 * (Kaleido's mpv.conf has `save-position-on-quit`): the file in mpv's `watch_later` folder named by
 * the MD5 of the clip's path. It holds the position, which the spec's `--start=0` now overrides
 * (Ruling R55), and every other option that was changed: the volume, the tracks, a loop, the
 * speed. A saved `vid=no` (video off) would leave no 720p badge, a loop or a speed would make the
 * run another one. `onPrepare` removes it, so every run starts the clip as a first one does.
 */
export const CLIP_SAVED_STATE = path.join(
  process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'),
  'Kaleido',
  'state',
  'watch_later',
  createHash('md5').update(CLIP, 'utf8').digest('hex').toUpperCase(),
);

/** Microsoft Edge WebDriver in the WebView2 runtime's version (`e2e/fetch-driver.ps1`). */
export const EDGE_DRIVER =
  process.env['KALEIDO_EDGE_DRIVER'] ?? path.join(ROOT, 'e2e', 'driver', 'msedgedriver.exe');

/**
 * tauri-driver: `$KALEIDO_TAURI_DRIVER`, else where `cargo install tauri-driver` put it
 * (`$CARGO_HOME\bin`), else the first one on `PATH`, else Cargo's default `~\.cargo\bin`.
 */
function findTauriDriver(): string {
  const chosen = process.env['KALEIDO_TAURI_DRIVER'];
  if (chosen !== undefined && chosen !== '') return chosen;
  const exe = 'tauri-driver.exe';
  const cargoHome = process.env['CARGO_HOME'];
  const onPath = (process.env['PATH'] ?? '')
    .split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir !== '')
    .map((dir) => path.join(dir, exe));
  const candidates = [...(cargoHome ? [path.join(cargoHome, 'bin', exe)] : []), ...onPath];
  return candidates.find((file) => existsSync(file)) ?? path.join(os.homedir(), '.cargo', 'bin', exe);
}

export const TAURI_DRIVER = findTauriDriver();

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
