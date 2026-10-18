/**
 * The smoke E2E (WebdriverIO): tauri-driver starts the built Kaleido and hands the WebDriver
 * requests to Microsoft Edge WebDriver, which drives the app's WebView2.
 *
 *     npm run e2e:build   (kaleido-mpv, the debug app with the UI inside, the clip)
 *     npm run e2e
 *
 * Needs `cargo install tauri-driver --locked --version 2.1.0` (the version CI uses) and an
 * msedgedriver in the version of the WebView2 runtime (`e2e/fetch-driver.ps1`). Like any start of
 * Kaleido, the run uses the user's own %APPDATA%\Kaleido and %LOCALAPPDATA%\Kaleido: a mpv.conf
 * there that starts files paused or loops them (`pause`, `loop-file`, `loop-playlist`) can make
 * the smoke test fail.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { SevereServiceError } from 'webdriverio';

import { APP, CLIP, EDGE_DRIVER, kaleidoProcesses, TAURI_DRIVER } from './support';

const PORT = 4444;
const NATIVE_PORT = 4445;

let tauriDriver: ChildProcess | undefined;

/** Resolves once something listens on the port, rejects after `ms`. */
function waitForPort(port: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`nothing listens on port ${port} after ${ms} ms`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

/** Ends tauri-driver with everything it started: msedgedriver and, after a failed test, the app. */
function stopTauriDriver() {
  const pid = tauriDriver?.pid;
  tauriDriver = undefined;
  if (pid === undefined) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Already gone.
  }
}

/**
 * tauri-driver's own capability (WebdriverIO does not know it): the app to start. Without a clip:
 * msedgedriver makes every argument a Chromium switch (a path arrives as `--c:\…`, and `--` is
 * refused), so the spec opens the clip with a second start of the app instead.
 */
const app = {
  'tauri:options': { application: APP },
  // tauri-driver speaks classic WebDriver only.
  'wdio:enforceWebDriverClassic': true,
};

export const config: WebdriverIO.Config = {
  runner: 'local',
  hostname: '127.0.0.1',
  port: PORT,
  specs: ['./smoke.e2e.ts'],
  maxInstances: 1,
  capabilities: [app],
  logLevel: 'warn',
  // Starting a debug build and its WebView2 takes a while on a cold machine.
  connectionRetryTimeout: 60_000,
  connectionRetryCount: 1,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 60_000 },

  onPrepare() {
    const missing = [
      [APP, 'npm run e2e:build (a debug build with the UI inside)'],
      [CLIP, 'powershell -File e2e/make-media.ps1'],
      [EDGE_DRIVER, 'powershell -File e2e/fetch-driver.ps1'],
      [TAURI_DRIVER, 'cargo install tauri-driver --locked --version 2.1.0'],
    ].filter(([file]) => !existsSync(file));
    if (missing.length > 0) {
      const lines = missing.map(([file, remedy]) => `  ${file}\n    → ${remedy}`).join('\n');
      throw new SevereServiceError(`The E2E run is missing:\n${lines}`);
    }
    // A running Kaleido (any build: they share one single-instance identity) would take the clip
    // over, and the started one would end at once.
    const running = kaleidoProcesses().filter((p) => p.name.toLowerCase() === 'kaleido.exe');
    if (running.length > 0) {
      const list = running.map((p) => `  ${p.path || '?'} (process ${String(p.pid)})`).join('\n');
      throw new SevereServiceError(`Close Kaleido first:\n${list}`);
    }
  },

  async beforeSession() {
    tauriDriver = spawn(
      TAURI_DRIVER,
      ['--port', String(PORT), '--native-port', String(NATIVE_PORT), '--native-driver', EDGE_DRIVER],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    tauriDriver.once('exit', (code) => {
      if (tauriDriver !== undefined) console.error(`tauri-driver exited early (code ${String(code)})`);
    });
    await waitForPort(PORT, 10_000);
  },

  afterSession() {
    stopTauriDriver();
  },
};

// A worker that ends some other way (a crash, a cancelled run) must not leave tauri-driver and
// msedgedriver behind.
process.once('exit', stopTauriDriver);
