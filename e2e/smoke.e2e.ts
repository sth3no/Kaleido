/**
 * The smoke test of the built app (plan Task 24): `Kaleido.exe <clip>` plays the clip, the
 * controls reach mpv and come back with its state, the Settings page brings the mini player, and
 * closing the window ends the app. Runs against a real libmpv and WebView2 (e2e/wdio.conf.ts).
 *
 * The app speaks the system's language: a control is found by its label in either language.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { $, browser, expect } from '@wdio/globals';

import { APP, appProcesses, CLIP, isAlive, ROOT } from './support';

type Messages = { [key: string]: string | Messages };

const LOCALES = ['cs', 'en'].map((language) => {
  const file = path.join(ROOT, 'src', 'i18n', 'locales', `${language}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as Messages;
});

/** The text of a message key (`player.pause`) in Czech and in English. */
function texts(key: string): string[] {
  return LOCALES.map((messages) => {
    let node: string | Messages | undefined = messages;
    for (const part of key.split('.')) node = typeof node === 'object' ? node[part] : undefined;
    if (typeof node !== 'string') throw new Error(`no message ${key}`);
    return node;
  });
}

/** A button named by its `aria-label`. */
function button(key: string): string {
  return texts(key)
    .map((text) => `button[aria-label="${text}"]`)
    .join(', ');
}

/** The UI hides its controls after 2.5 s without the mouse moving: moving it brings them back. */
async function wakeControls() {
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: 400, y: 300, origin: 'viewport' })
    .move({ x: 420, y: 320, origin: 'viewport' })
    .perform();
}

/** Waits until `selector` exists with exactly `text` in it (whether the autohide shows it or not). */
async function waitForText(selector: string, text: string, timeout: number, what: string) {
  const element = $(selector);
  await browser.waitUntil(
    async () => (await element.isExisting()) && (await element.getProperty('textContent')) === text,
    { timeout, interval: 100, timeoutMsg: `${what} never showed ${text}` },
  );
}

/** `promise`, or `timedOut` after `ms`. */
async function within<T, U>(promise: Promise<T>, ms: number, timedOut: U): Promise<T | U> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<U>((resolve) => {
    timer = setTimeout(() => {
      resolve(timedOut);
    }, ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

describe('Kaleido started with a clip', () => {
  it('a second `Kaleido.exe <clip>` hands the clip over and ends, and the clip is in the title island within 5 s', async () => {
    // tauri-driver started the app without the clip (wdio.conf.ts): this start hands its command
    // line to the running app (single instance), as opening a file from Explorer does, and ends.
    // `--start=0`: a position an earlier run saved must not move the clip towards its end.
    const started = Date.now();
    const second = spawn(APP, ['--start=0', '--', CLIP], { stdio: 'ignore' });
    const ended = new Promise<number | null>((resolve) => {
      second.once('exit', resolve);
      second.once('error', () => {
        resolve(null);
      });
    });

    /** What is left of the 5 s. */
    const left = () => Math.max(0, 5_000 - (Date.now() - started));

    try {
      await wakeControls();
      await waitForText('[data-island] span[title]', path.basename(CLIP), left(), 'the title island');
      // video-params came from mpv: the clip is decoded, not only named.
      await waitForText('[data-island] span[title] + span', '720p', left(), 'the badge');
      expect(await within(ended, 5_000, 'still running')).toBe(0);
    } finally {
      // A second start that did not end (it hung, or a wait above failed) must not outlive the run.
      if (second.exitCode === null) second.kill();
    }
  });

  it('play/pause switches between playing and paused', async () => {
    // The button carries the state in its name (Pause while playing, Play while paused), which
    // follows mpv's `pause` property: the click went to mpv and the answer came back. (It has no
    // `aria-pressed`: a toggle button whose name changes must not also be pressed, WAI-ARIA.)
    await wakeControls();
    const pause = $(button('player.pause'));
    await pause.waitForClickable({ timeout: 5_000, timeoutMsg: 'the clip is not playing' });
    await pause.click();
    const play = $(button('player.play'));
    await play.waitForExist({ timeout: 3_000, timeoutMsg: 'the click did not pause the clip' });

    await wakeControls();
    await play.waitForClickable({ timeout: 3_000 });
    await play.click();
    await $(button('player.pause')).waitForExist({
      timeout: 3_000,
      timeoutMsg: 'the click did not resume the clip',
    });
  });

  it('opening Settings shows the mini player', async () => {
    await wakeControls();
    const menu = $(button('shell.menu'));
    await menu.waitForClickable({ timeout: 3_000 });
    await menu.click();
    const names = texts('shell.sidebar.settings')
      .map((text) => `normalize-space(.)="${text}"`)
      .join(' or ');
    const settings = $(`//nav//button[${names}]`);
    await settings.waitForClickable({ timeout: 3_000 });
    await settings.click();

    const mini = $('[data-mini-frame][data-phase="mini"]');
    await mini.waitForDisplayed({
      timeout: 3_000,
      timeoutMsg: 'no docked mini player on the Settings page',
    });
    // Docked, it has its own controls: play/pause, back to the player, stop.
    await expect(mini.$$('button')).toBeElementsArrayOfSize(3);
  });

  it('closing the window ends the app within 2 s', async () => {
    const processes = appProcesses();
    const app = processes.find((p) => p.name.toLowerCase() === 'kaleido.exe');
    if (app === undefined) throw new Error('the app under test is not running');

    const close = $(button('shell.window.close'));
    await close.waitForClickable({ timeout: 3_000 });
    const clicked = Date.now();
    try {
      await close.click();
    } catch {
      // The app may go away before the driver has answered the click; the processes decide.
    }
    while (processes.some((p) => isAlive(p.pid)) && Date.now() - clicked < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const left = processes.filter((p) => isAlive(p.pid));
    if (left.length > 0) {
      const names = left.map((p) => `${p.name} ${String(p.pid)}`).join(', ');
      throw new Error(`still running 2 s after the close: ${names}`);
    }
  });
});
