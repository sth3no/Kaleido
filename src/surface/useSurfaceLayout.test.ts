import { invoke } from '@tauri-apps/api/core';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { Layout } from '../ipc/types';
import miniCss from '../mini/MiniPlayer.module.css?raw';
import { usePlayerStore, type PlayerState } from '../state/playerStore';
import { useUiStore } from '../state/uiStore';
import { miniLayout, miniRect, type Rect } from './mini';
import {
  createLayoutSender,
  durationMs,
  MINI_MOTION_MS,
  motionSlowMs,
  useSurfaceLayout,
} from './useSurfaceLayout';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

/**
 * The timers the tests move, the animation frames among them. Not `setImmediate`: React's `act`
 * waits on it, and the async advances below let the promises settle with it after every timer.
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

/** Lets `ms` of timers and animation frames come, and Rust answer after each. */
const wait = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** Lets Rust answer what was sent (one layout at a time goes, the next when it has). */
const settle = () => wait(0);

const toPage = async (page: 'player' | 'settings') => {
  act(() => {
    useUiStore.getState().setPage(page);
  });
  await settle();
};

const setPlayer = async (state: Partial<PlayerState>) => {
  act(() => {
    usePlayerStore.setState(state);
  });
  await settle();
};

/**
 * How many animation frames are asked for in the next 100 ms: none at rest. A loop that still ran
 * would ask for its next frame in each one that came.
 */
const framesAsked = async (): Promise<number> => {
  const asked = vi.spyOn(globalThis, 'requestAnimationFrame');
  try {
    await wait(100);
    return asked.mock.calls.length;
  } finally {
    asked.mockRestore();
  }
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: FAKE });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(() => Promise.resolve(null));
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
  vi.restoreAllMocks();
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true });
});

test('the player page has the whole window, and says so once at start', async () => {
  const { result } = renderHook(() => useSurfaceLayout());
  await settle();
  expect(result.current).toEqual({ phase: 'full', rect: null, fade: false });
  expect(layouts()).toEqual([{ kind: 'full' }]);
});

test('another page shrinks the video into the corner, a frame at a time, and docks it there', async () => {
  const { result } = renderHook(() => useSurfaceLayout());
  await toPage('settings');
  // It starts from the whole window.
  expect(result.current).toEqual({ phase: 'shrinking', rect: WHOLE, fade: false });

  await wait(MINI_MOTION_MS + 50);
  const sent = layouts().slice(1);
  const moving = frames(sent);
  // A frame every animation frame (16 ms) for 250 ms, each sent once Rust has the one before.
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

test('one layout at a time goes to Rust, and of the frames that waited only the newest', async () => {
  // Rust answers only when the test says.
  const answers: (() => void)[] = [];
  vi.mocked(invoke).mockImplementation(((command: string) =>
    command === 'surface_set_layout'
      ? new Promise((resolve) => {
          answers.push(() => {
            resolve(null);
          });
        })
      : Promise.resolve(null)) as unknown as typeof invoke);
  const { result } = renderHook(() => useSurfaceLayout());
  expect(layouts()).toEqual([{ kind: 'full' }]);

  await toPage('settings');
  await wait(100);
  // Six frames came while `full` was on its way: none of them went yet.
  expect(result.current.phase).toBe('shrinking');
  expect(layouts()).toHaveLength(1);

  // Rust has it: only the newest place goes, the frames before it never do.
  await act(async () => {
    answers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(layouts()).toEqual([{ kind: 'full' }, { kind: 'rect', ...result.current.rect }]);

  // The animation ends while that frame is on its way: the docked layout follows it, and the
  // frames in between are dropped.
  await wait(MINI_MOTION_MS);
  expect(result.current.phase).toBe('mini');
  expect(layouts()).toHaveLength(2);
  await act(async () => {
    answers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(layouts().at(-1)).toEqual(MINI);
  expect(layouts()).toHaveLength(3);
});

test('the sender keeps every layout that is not a frame, in order', async () => {
  const posted: Layout[] = [];
  const answers: (() => void)[] = [];
  const send = createLayoutSender(
    (layout) =>
      new Promise((resolve) => {
        posted.push(layout);
        answers.push(() => {
          resolve(null);
        });
      }),
  );
  const rect = (x: number): Layout => ({ kind: 'rect', x, y: 0, w: 10, h: 10 });
  send({ kind: 'full' });
  send(rect(1));
  send(rect(2));
  send({ kind: 'hidden' });
  send(MINI);
  send(rect(3));
  send(rect(4));
  for (let i = 0; i < 5; i += 1) {
    answers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
  }
  // The frames that waited behind `full` were dropped when `hidden` came; of the last two, the
  // newest went.
  expect(posted).toEqual([{ kind: 'full' }, { kind: 'hidden' }, MINI, rect(4)]);
});

test('the animation frames stop at rest: nothing runs per frame while docked', async () => {
  const { result } = renderHook(() => useSurfaceLayout());
  await toPage('settings');
  await wait(MINI_MOTION_MS + 50);
  expect(result.current.phase).toBe('mini');
  // No animation frame is asked for any more (spec 13), and nothing more goes to Rust.
  expect(await framesAsked()).toBe(0);
  const count = layouts().length;
  await wait(5000);
  expect(layouts()).toHaveLength(count);

  // A wider window moves the hole into the new corner; Rust keeps mpv's window there by itself,
  // and still no frame runs.
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true, writable: true });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  await settle();
  expect(result.current.rect).toEqual(miniRect(MINI, 1280, 768));
  expect(layouts()).toHaveLength(count);
  expect(await framesAsked()).toBe(0);
});

test('expanding returns to the full layout', async () => {
  const { result } = renderHook(() => useSurfaceLayout());
  await toPage('settings');
  await wait(MINI_MOTION_MS + 50);
  const docked = layouts().length;

  await toPage('player');
  expect(result.current).toEqual({ phase: 'growing', rect: DOCKED, fade: false });
  await wait(MINI_MOTION_MS + 50);
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
  expect(await framesAsked()).toBe(0);
});

test('turning round half-way goes back from where the video is', async () => {
  const { result } = renderHook(() => useSurfaceLayout());
  await toPage('settings');
  await wait(100);
  const halfway = result.current.rect;
  expect(result.current.phase).toBe('shrinking');
  await toPage('player');
  expect(result.current).toEqual({ phase: 'growing', rect: halfway, fade: false });
  await wait(MINI_MOTION_MS + 50);
  expect(layouts().at(-1)).toEqual({ kind: 'full' });
  expect(await framesAsked()).toBe(0);
});

test('the animation takes as long as the motion token on the root says', async () => {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) =>
    element === document.documentElement
      ? ({
          getPropertyValue: (name: string) => (name === '--k-motion-slow' ? '500ms' : ''),
        } as CSSStyleDeclaration)
      : real(element, pseudo),
  );
  expect(motionSlowMs()).toBe(500);
  const { result } = renderHook(() => useSurfaceLayout());
  await toPage('settings');
  await wait(MINI_MOTION_MS + 50);
  // 250 ms in, half-way through 500.
  expect(result.current.phase).toBe('shrinking');
  await wait(250);
  expect(result.current.phase).toBe('mini');
});

test('the motion token is read in ms or s, and is the token itself until it is applied', () => {
  expect(durationMs('250ms', 1)).toBe(250);
  expect(durationMs(' 0.3s', 1)).toBe(300);
  expect(durationMs('', 7)).toBe(7);
  expect(durationMs('fast', 7)).toBe(7);
  // jsdom's root has no tokens: the token's own value, 250 ms.
  expect(motionSlowMs()).toBe(MINI_MOTION_MS);
  expect(MINI_MOTION_MS).toBe(250);
});

test('reduced motion jumps and fades instead of animating', async () => {
  reducedMotion = true;
  const { result } = renderHook(() => useSurfaceLayout());
  await toPage('settings');
  // Hidden, then in the corner at once: no frames in between, and none asked for.
  expect(layouts()).toEqual([{ kind: 'full' }, { kind: 'hidden' }, MINI]);
  expect(result.current).toEqual({ phase: 'mini', rect: DOCKED, fade: true });
  expect(await framesAsked()).toBe(0);
  // The fade is over after the token's time.
  await wait(MINI_MOTION_MS);
  expect(result.current).toEqual({ phase: 'mini', rect: DOCKED, fade: false });

  // Back: hidden, then the whole window, and it fades too (a cover over the whole window).
  await toPage('player');
  expect(layouts().slice(3)).toEqual([{ kind: 'hidden' }, { kind: 'full' }]);
  expect(result.current).toEqual({ phase: 'full', rect: null, fade: true });
  expect(await framesAsked()).toBe(0);
  await wait(MINI_MOTION_MS);
  expect(result.current).toEqual({ phase: 'full', rect: null, fade: false });

  // The fades are CSS opacity transitions from where `@starting-style` puts the frame and the
  // cover: no keyframes. Under Mica the cover is a plain colour, so it fades there too.
  expect(miniCss).toMatch(/\.frame\s*\{[^}]*transition:\s*opacity/);
  expect(miniCss).toMatch(/@starting-style\s*\{\s*\.frame\[data-fade='true'\]\s*\{\s*opacity:\s*0/);
  expect(miniCss).toMatch(/\.cover\s*\{[^}]*transition:\s*opacity/);
  expect(miniCss).toMatch(/@starting-style\s*\{\s*\.cover\s*\{\s*opacity:\s*1/);
  expect(miniCss).toMatch(/:root\[data-mica\]\)\s*\.cover\s*\{\s*background:\s*var\(--k-color-bg\)/);
  expect(miniCss).not.toContain('@keyframes');
});

test('a file that closes on the page leaves at once, and one that opens there comes up in place', async () => {
  const { result } = renderHook(() => useSurfaceLayout());
  await toPage('settings');
  await wait(MINI_MOTION_MS + 50);

  // Stop: idle. The page is opaque again over the whole-window video.
  await setPlayer({ loaded: false, props: { 'idle-active': true } });
  expect(layouts().at(-1)).toEqual({ kind: 'full' });
  expect(result.current).toEqual({ phase: 'full', rect: null, fade: false });
  expect(await framesAsked()).toBe(0);

  // A file opened while the page is shown: there was no big picture to shrink.
  await setPlayer({ loaded: true, props: PLAYING });
  expect(layouts().slice(-2)).toEqual([{ kind: 'hidden' }, MINI]);
  expect(result.current).toEqual({ phase: 'mini', rect: DOCKED, fade: true });
});

test('the next file of the playlist keeps the mini player', async () => {
  const { result } = renderHook(() => useSurfaceLayout());
  await toPage('settings');
  await wait(MINI_MOTION_MS + 50);
  const count = layouts().length;
  // Between two files mpv is not idle: the file is open all the while.
  await setPlayer({ loaded: false, props: { ...PLAYING, 'time-pos': null } });
  await setPlayer({ loaded: true, props: PLAYING });
  expect(layouts()).toHaveLength(count);
  expect(result.current.phase).toBe('mini');
});

test('the docked mini player takes the shape of the video and the UI scale', async () => {
  const { result } = renderHook(() => useSurfaceLayout());
  await toPage('settings');
  await wait(MINI_MOTION_MS + 50);

  // A 4:3 file comes next: 360 × 270.
  await setPlayer({ props: { ...PLAYING, 'video-params': { dw: 1440, dh: 1080 } } });
  const fourThree = miniLayout(4 / 3);
  expect(fourThree.h).toBe(270);
  expect(layouts().at(-1)).toEqual(fourThree);
  expect(result.current.rect).toEqual(miniRect(fourThree, 1024, 768));

  // The UI scale goes to 125 %: the mini player with it, in px of the window.
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) =>
    element === document.documentElement
      ? ({ getPropertyValue: (name: string) => (name === 'zoom' ? '1.25' : '') } as CSSStyleDeclaration)
      : real(element, pseudo),
  );
  try {
    await act(async () => {
      document.documentElement.style.setProperty('--k-ui-scale', '1.25');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(layouts().at(-1)).toEqual(miniLayout(4 / 3, 1.25));
    expect(result.current.rect).toEqual(miniRect(miniLayout(4 / 3, 1.25), 1024, 768));
  } finally {
    document.documentElement.style.removeProperty('--k-ui-scale');
  }
});

test('the window is read to the fraction of a px, as Rust has it (Ruling R47)', async () => {
  // A client 1921 × 1081 px at 150 %: innerWidth would say 1281 or 1280, the visual viewport 1280.67.
  vi.stubGlobal('visualViewport', { width: 1921 / 1.5, height: 1081 / 1.5, scale: 1 });
  const { result } = renderHook(() => useSurfaceLayout());
  await toPage('settings');
  await wait(MINI_MOTION_MS + 50);
  expect(result.current.rect).toEqual(miniRect(MINI, 1921 / 1.5, 1081 / 1.5));
});
