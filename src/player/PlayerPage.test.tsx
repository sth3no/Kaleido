import { invoke } from '@tauri-apps/api/core';
import { act, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi, type MockInstance } from 'vitest';

import { initI18n } from '../i18n';
import type { GlassRect } from '../ipc/types';
import { usePlayerStore } from '../state/playerStore';
import { useUiStore } from '../state/uiStore';
import { CURTAIN_MAX_MS } from './fullscreen';
import PlayerPage, { FADE_OUT_MS } from './PlayerPage';
import { AUTOHIDE_MS } from './useAutohide';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

/**
 * The timers the tests move. Not `setImmediate`: React's `await act(...)` waits on it, and a faked one
 * would never come while the test is waiting.
 */
const FAKE: NonNullable<Parameters<typeof vi.useFakeTimers>[0]>['toFake'] = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'Date',
  'performance',
  'requestAnimationFrame',
  'cancelAnimationFrame',
];

let measured: MockInstance<() => DOMRect>;

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: FAKE });
  vi.mocked(invoke).mockClear();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  // The island is at the bottom of the window: 92 px high, 16 px above the edge.
  measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({ left: 100, top: 660, width: 800, height: 92, right: 900, bottom: 752, x: 100, y: 660 }) as DOMRect,
  );
  usePlayerStore.setState({
    loaded: true,
    props: { 'idle-active': false, pause: false, 'time-pos': 10, duration: 600, fullscreen: false },
  });
});

afterEach(() => {
  measured.mockRestore();
  vi.useRealTimers();
  document.documentElement.style.cursor = '';
});

const island = () => document.querySelector('[data-island]');
const curtain = () => document.querySelector('[data-on]');

/** The glass regions Rust was last given. */
const regions = (): GlassRect[] | undefined =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === 'glass_set_regions')
    .map(([, args]) => (args as { rects: GlassRect[] }).rects)
    .at(-1);

const margins = (): unknown[] =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === 'player_command')
    .map(([, args]) => (args as { cmd: { type: string; margin?: number } }).cmd)
    .filter((cmd) => cmd.type === 'setSubMargin')
    .map((cmd) => cmd.margin);

const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

test('the island fades after 2500 ms of stillness, is gone when it has faded, and comes back with a move', () => {
  render(<PlayerPage />);
  expect(island()?.getAttribute('data-hidden')).toBe('false');

  advance(AUTOHIDE_MS - 1);
  expect(island()?.getAttribute('data-hidden')).toBe('false');
  advance(1);
  // Fading: still there, out of reach, and the shell's own islands are told.
  expect(island()?.getAttribute('data-hidden')).toBe('true');
  expect(island()?.hasAttribute('inert')).toBe(true);
  expect(useUiStore.getState().controlsHidden).toBe(true);
  expect(document.documentElement.style.cursor).toBe('none');

  advance(FADE_OUT_MS);
  expect(island()).toBeNull();

  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 200 }));
  });
  expect(island()?.getAttribute('data-hidden')).toBe('false');
  expect(useUiStore.getState().controlsHidden).toBe(false);
  expect(document.documentElement.style.cursor).toBe('');
});

test('a move while the island fades keeps it, without taking it away and putting it back', () => {
  render(<PlayerPage />);
  advance(AUTOHIDE_MS);
  const fading = island();
  expect(fading?.getAttribute('data-hidden')).toBe('true');

  advance(FADE_OUT_MS / 2);
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 200 }));
  });
  advance(FADE_OUT_MS * 2);
  // The same element: it was never taken away.
  expect(island()).toBe(fading);
  expect(island()?.getAttribute('data-hidden')).toBe('false');
});

test('a hidden island keeps no glass region, and the subtitles drop with it', () => {
  render(<PlayerPage />);
  // The frames of the glass run on the timers here.
  advance(50);
  const shown = regions();
  expect(shown?.length ?? 0).toBeGreaterThan(0);
  const lifted = margins();
  expect(lifted).toHaveLength(1);
  expect(lifted[0]).toBeGreaterThan(0);

  advance(AUTOHIDE_MS + FADE_OUT_MS + 50);
  expect(island()).toBeNull();
  expect(regions()).toEqual([]);
  expect(margins()).toEqual([lifted[0], 0]);
});

test('there is no island while the file is only loading', () => {
  act(() => {
    usePlayerStore.setState({ loaded: false, props: { 'idle-active': false } });
  });
  render(<PlayerPage />);
  expect(island()).toBeNull();

  act(() => {
    usePlayerStore.getState().fileLoaded();
  });
  expect(island()).not.toBeNull();
});

test('nothing hides while the video is paused or a panel is open', () => {
  render(<PlayerPage />);
  act(() => {
    usePlayerStore.getState().applyChanges({ pause: true });
  });
  advance(10_000);
  expect(island()?.getAttribute('data-hidden')).toBe('false');

  act(() => {
    usePlayerStore.getState().applyChanges({ pause: false });
    useUiStore.getState().setPanel('quick-settings');
  });
  advance(10_000);
  expect(island()?.getAttribute('data-hidden')).toBe('false');
});

test('leaving the player gives the cursor and the shell back', () => {
  const { unmount } = render(<PlayerPage />);
  advance(AUTOHIDE_MS);
  expect(document.documentElement.style.cursor).toBe('none');

  unmount();
  expect(document.documentElement.style.cursor).toBe('');
  expect(useUiStore.getState().controlsHidden).toBe(false);
});

test('a black curtain covers the window while mpv switches to fullscreen, and no longer than 500 ms', async () => {
  render(<PlayerPage />);
  expect(curtain()?.getAttribute('data-on')).toBe('false');
  // In the body, over the shell: not in the page.
  expect(curtain()?.parentElement).toBe(document.body);

  await act(async () => {
    usePlayerStore.getState().applyChanges({ fullscreen: true });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(curtain()?.getAttribute('data-on')).toBe('true');

  await act(async () => {
    await vi.advanceTimersByTimeAsync(CURTAIN_MAX_MS + 100);
  });
  expect(curtain()?.getAttribute('data-on')).toBe('false');
});
