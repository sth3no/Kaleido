import { invoke } from '@tauri-apps/api/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi, type MockInstance } from 'vitest';

import { initI18n } from '../i18n';
import type { CaptionButton } from '../ipc/types';
import { usePlayerStore } from '../state/playerStore';
import WindowIsland from './WindowIsland';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
const appWindow = vi.hoisted(() => ({
  minimize: vi.fn(() => Promise.resolve()),
  toggleMaximize: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  isMaximized: vi.fn(() => Promise.resolve(false)),
  onResized: vi.fn<(handler: () => void) => Promise<() => void>>(() => Promise.resolve(() => undefined)),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => appWindow }));

/** The animation frames asked for and not run yet. */
let frames: FrameRequestCallback[] = [];

function runFrame(): void {
  const due = frames;
  frames = [];
  for (const callback of due) callback(performance.now());
}

let measured: MockInstance<() => DOMRect>;

/** What was sent to `surface_set_caption_buttons`, each call. */
const captionButtons = (): CaptionButton[][] =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === 'surface_set_caption_buttons')
    .map(([, args]) => (args as { rects: CaptionButton[] }).rects);

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  frames = [];
  vi.mocked(invoke).mockClear();
  for (const action of Object.values(appWindow)) action.mockClear();
  appWindow.isMaximized.mockImplementation(() => Promise.resolve(false));
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  // The maximise button of a 1280 px window, 16 px from the top: 36 × 32.
  measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const maximize = this.getAttribute('aria-label') === 'Maximize';
    const box = maximize ? { left: 1196, top: 16, width: 36, height: 32 } : { left: 0, top: 0, width: 0, height: 0 };
    return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height } as DOMRect;
  });
});

afterEach(() => {
  // Unmounted while the frames are still ours, and the last frame run: nothing is left waiting.
  cleanup();
  runFrame();
  measured.mockRestore();
  vi.unstubAllGlobals();
});

test('the buttons minimise, maximise and close the window', () => {
  render(<WindowIsland overVideo />);

  fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
  fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));

  expect(appWindow.minimize).toHaveBeenCalledTimes(1);
  expect(appWindow.toggleMaximize).toHaveBeenCalledTimes(1);
  // Closing goes through the window, whose CloseRequested lets mpv save the position.
  expect(appWindow.close).toHaveBeenCalledTimes(1);
});

test('a maximised window offers to restore it, and follows the window after a resize', async () => {
  appWindow.isMaximized.mockImplementation(() => Promise.resolve(true));
  render(<WindowIsland overVideo={false} />);
  expect(await screen.findByRole('button', { name: 'Restore' })).toBeTruthy();

  // Restored (from the taskbar, a snap, a double click on the title bar): the window resized.
  appWindow.isMaximized.mockImplementation(() => Promise.resolve(false));
  const [[onResized] = []] = appWindow.onResized.mock.calls;
  act(() => {
    onResized?.();
  });
  expect(await screen.findByRole('button', { name: 'Maximize' })).toBeTruthy();
});

test('the maximise button is where Windows answers for it, but not in fullscreen', () => {
  render(<WindowIsland overVideo />);
  const maximize = screen.getByRole('button', { name: 'Maximize' }) as HTMLButtonElement;
  runFrame();
  expect(captionButtons().at(-1)).toEqual([{ x: 1196, y: 16, w: 36, h: 32 }]);
  expect(maximize.disabled).toBe(false);

  // Fullscreen: nothing to maximise. The button is off and Windows no longer answers for it.
  act(() => {
    usePlayerStore.setState({ props: { fullscreen: true } });
  });
  runFrame();
  expect(captionButtons().at(-1)).toEqual([]);
  expect(maximize.disabled).toBe(true);
  fireEvent.click(maximize);
  expect(appWindow.toggleMaximize).not.toHaveBeenCalled();
});
