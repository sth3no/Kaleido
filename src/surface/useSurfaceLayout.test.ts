import { invoke } from '@tauri-apps/api/core';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { Layout } from '../ipc/types';
import miniCss from '../mini/MiniPlayer.module.css?raw';
import { usePlayerStore } from '../state/playerStore';
import { useUiStore } from '../state/uiStore';
import { miniLayout, miniRect, type Rect } from './mini';
import { MINI_MOTION_MS, useSurfaceLayout } from './useSurfaceLayout';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

/**
 * The timers the tests move, the animation frames among them. Not `setImmediate`: React's `act`
 * waits on it.
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

const PLAYING = {
  'idle-active': false,
  pause: false,
  'time-pos': 12,
  duration: 600,
  'video-params': { w: 1920, h: 1080, dw: 1920, dh: 1080 },
};

/** jsdom's window: 1024 × 768. */
const WHOLE: Rect = { x: 0, y: 0, w: 1024, h: 768 };
/** The docked mini player of a 16:9 video in it: 360 × 203, 16 px from the corner. */
const MINI = miniLayout(16 / 9);
const DOCKED = miniRect(MINI, WHOLE.w, WHOLE.h);

/** Whether Windows' animations are off. */
let reducedMotion = false;

/** The layouts Rust was given, in order. */
const layouts = (): Layout[] =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === 'surface_set_layout')
    .map(([, args]) => (args as { layout: Layout }).layout);

const frames = (sent: Layout[]) => sent.filter((layout) => layout.kind === 'rect');

const toPage = (page: 'player' | 'settings') => {
  act(() => {
    useUiStore.getState().setPage(page);
  });
};

/** Lets `ms` of animation frames come. */
const wait = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

/**
 * How many animation frames are asked for in the next 100 ms: none at rest. A loop that still ran
 * would ask for its next frame in each one that came.
 */
const framesAsked = (): number => {
  const asked = vi.spyOn(globalThis, 'requestAnimationFrame');
  try {
    wait(100);
    return asked.mock.calls.length;
  } finally {
    asked.mockRestore();
  }
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: FAKE });
  vi.mocked(invoke).mockClear();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  usePlayerStore.setState({ loaded: true, props: PLAYING });
  reducedMotion = false;
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      media: query,
      matches: reducedMotion && query === '(prefers-reduced-motion: reduce)',
    })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true });
});

test('the player page has the whole window, and says so once at start', () => {
  const { result } = renderHook(() => useSurfaceLayout());
  expect(result.current).toEqual({ phase: 'full', rect: null, fade: false });
  expect(layouts()).toEqual([{ kind: 'full' }]);
});

test('another page shrinks the video into the corner, a frame at a time, and docks it there', () => {
  const { result } = renderHook(() => useSurfaceLayout());
  toPage('settings');
  // It starts from the whole window.
  expect(result.current).toEqual({ phase: 'shrinking', rect: WHOLE, fade: false });

  wait(MINI_MOTION_MS + 50);
  const sent = layouts().slice(1);
  const moving = frames(sent);
  // A frame every animation frame (16 ms) for 250 ms.
  expect(moving.length).toBeGreaterThanOrEqual(10);
  // Smaller every frame, and the last one is the corner, before the docked layout.
  for (let i = 1; i < moving.length; i += 1) {
    const [before, now] = [moving[i - 1], moving[i]];
    if (before?.kind === 'rect' && now?.kind === 'rect') expect(now.w).toBeLessThanOrEqual(before.w);
  }
  expect(moving.at(-1)).toEqual({ kind: 'rect', ...DOCKED });
  expect(sent.at(-1)).toEqual(MINI);
  expect(MINI).toEqual({ kind: 'mini', w: 360, h: 203, right: 16, bottom: 16 });
  expect(result.current).toEqual({ phase: 'mini', rect: DOCKED, fade: false });
});

test('the animation frames stop at rest: nothing runs per frame while docked', () => {
  const { result } = renderHook(() => useSurfaceLayout());
  toPage('settings');
  wait(MINI_MOTION_MS + 50);
  expect(result.current.phase).toBe('mini');
  // No animation frame is asked for any more (spec 13), and nothing more goes to Rust.
  expect(framesAsked()).toBe(0);
  const count = layouts().length;
  wait(5000);
  expect(layouts()).toHaveLength(count);

  // A wider window moves the hole into the new corner; Rust keeps mpv's window there by itself,
  // and still no frame runs.
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true, writable: true });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  expect(result.current.rect).toEqual(miniRect(MINI, 1280, 768));
  expect(layouts()).toHaveLength(count);
  expect(framesAsked()).toBe(0);
});

test('expanding returns to the full layout', () => {
  const { result } = renderHook(() => useSurfaceLayout());
  toPage('settings');
  wait(MINI_MOTION_MS + 50);
  const docked = layouts().length;

  toPage('player');
  expect(result.current).toEqual({ phase: 'growing', rect: DOCKED, fade: false });
  wait(MINI_MOTION_MS + 50);
  const back = layouts().slice(docked);
  const moving = frames(back);
  expect(moving.length).toBeGreaterThanOrEqual(10);
  // Larger every frame, up to the whole window, and then the whole window as a layout.
  for (let i = 1; i < moving.length; i += 1) {
    const [before, now] = [moving[i - 1], moving[i]];
    if (before?.kind === 'rect' && now?.kind === 'rect') expect(now.w).toBeGreaterThanOrEqual(before.w);
  }
  expect(moving.at(-1)).toEqual({ kind: 'rect', ...WHOLE });
  expect(back.at(-1)).toEqual({ kind: 'full' });
  expect(result.current).toEqual({ phase: 'full', rect: null, fade: false });
  expect(framesAsked()).toBe(0);
});

test('turning round half-way goes back from where the video is', () => {
  const { result } = renderHook(() => useSurfaceLayout());
  toPage('settings');
  wait(100);
  const halfway = result.current.rect;
  expect(result.current.phase).toBe('shrinking');
  toPage('player');
  expect(result.current).toEqual({ phase: 'growing', rect: halfway, fade: false });
  wait(MINI_MOTION_MS + 50);
  expect(layouts().at(-1)).toEqual({ kind: 'full' });
  expect(framesAsked()).toBe(0);
});

test('reduced motion jumps and fades instead of animating', () => {
  reducedMotion = true;
  const { result } = renderHook(() => useSurfaceLayout());
  toPage('settings');
  // Hidden, then in the corner at once: no frames in between, and none asked for.
  expect(layouts()).toEqual([{ kind: 'full' }, { kind: 'hidden' }, MINI]);
  expect(result.current).toEqual({ phase: 'mini', rect: DOCKED, fade: true });
  expect(framesAsked()).toBe(0);

  toPage('player');
  expect(layouts().slice(3)).toEqual([{ kind: 'hidden' }, { kind: 'full' }]);
  expect(result.current).toEqual({ phase: 'full', rect: null, fade: false });

  // The fade is a CSS opacity transition from where `@starting-style` puts the frame: no keyframes.
  expect(miniCss).toMatch(/\.frame\s*\{[^}]*transition:\s*opacity/);
  expect(miniCss).toMatch(/@starting-style\s*\{\s*\.frame\[data-fade='true'\]\s*\{\s*opacity:\s*0/);
  expect(miniCss).not.toContain('@keyframes');
});

test('a file that closes on the page leaves at once, and one that opens there comes up in place', () => {
  const { result } = renderHook(() => useSurfaceLayout());
  toPage('settings');
  wait(MINI_MOTION_MS + 50);

  // Stop: idle. The page is opaque again over the whole-window video.
  act(() => {
    usePlayerStore.setState({ loaded: false, props: { 'idle-active': true } });
  });
  expect(layouts().at(-1)).toEqual({ kind: 'full' });
  expect(result.current).toEqual({ phase: 'full', rect: null, fade: false });
  expect(framesAsked()).toBe(0);

  // A file opened while the page is shown: there was no big picture to shrink.
  act(() => {
    usePlayerStore.setState({ loaded: true, props: PLAYING });
  });
  expect(layouts().slice(-2)).toEqual([{ kind: 'hidden' }, MINI]);
  expect(result.current).toEqual({ phase: 'mini', rect: DOCKED, fade: true });
});

test('the next file of the playlist keeps the mini player', () => {
  const { result } = renderHook(() => useSurfaceLayout());
  toPage('settings');
  wait(MINI_MOTION_MS + 50);
  const count = layouts().length;
  // Between two files mpv is not idle: the file is open all the while.
  act(() => {
    usePlayerStore.setState({ loaded: false, props: { ...PLAYING, 'time-pos': null } });
  });
  act(() => {
    usePlayerStore.setState({ loaded: true, props: PLAYING });
  });
  expect(layouts()).toHaveLength(count);
  expect(result.current.phase).toBe('mini');
});

test('the docked mini player takes the shape of the video and the UI scale', async () => {
  const { result } = renderHook(() => useSurfaceLayout());
  toPage('settings');
  wait(MINI_MOTION_MS + 50);

  // A 4:3 file comes next: 360 × 270.
  act(() => {
    usePlayerStore.setState({ props: { ...PLAYING, 'video-params': { dw: 1440, dh: 1080 } } });
  });
  const fourThree = miniLayout(4 / 3);
  expect(fourThree.h).toBe(270);
  expect(layouts().at(-1)).toEqual(fourThree);
  expect(result.current.rect).toEqual(miniRect(fourThree, 1024, 768));

  // The UI scale goes to 125 %: the mini player with it, in px of the window.
  const real = window.getComputedStyle.bind(window);
  const styles = vi
    .spyOn(window, 'getComputedStyle')
    .mockImplementation((element: Element, pseudo?: string | null) =>
      element === document.documentElement
        ? ({ getPropertyValue: (name: string) => (name === 'zoom' ? '1.25' : '') } as CSSStyleDeclaration)
        : real(element, pseudo),
    );
  try {
    await act(async () => {
      document.documentElement.style.setProperty('--k-ui-scale', '1.25');
      await Promise.resolve();
    });
    expect(layouts().at(-1)).toEqual(miniLayout(4 / 3, 1.25));
    expect(result.current.rect).toEqual(miniRect(miniLayout(4 / 3, 1.25), 1024, 768));
  } finally {
    styles.mockRestore();
    document.documentElement.style.removeProperty('--k-ui-scale');
  }
});
