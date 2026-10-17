import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePlayerStore } from '../state/playerStore';
import {
  CURTAIN_MAX_MS,
  createFullscreenController,
  osdSize,
  sameSize,
  useFullscreenCurtain,
  waitForResize,
  windowSize,
  type FullscreenDeps,
} from './fullscreen';

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

function fake(): { log: string[]; deps: FullscreenDeps } {
  const log: string[] = [];
  return {
    log,
    deps: {
      setCurtain: (on) => {
        log.push(on ? 'curtain:on' : 'curtain:off');
      },
      nextFrame: async () => {
        log.push('frame');
      },
      waitForResize: async (ms) => {
        log.push(`resize:${ms}`);
      },
    },
  };
}

// Ported from the prototype: the same three cases. The window is no longer switched by the UI (Rust
// follows mpv), so there is no `fs:` step, and the wait for mpv's size starts with the curtain.
describe('createFullscreenController', () => {
  it('covers the switch with the curtain until mpv has the new size, at most 500 ms', async () => {
    const { log, deps } = fake();
    await createFullscreenController(deps)(true);
    expect(CURTAIN_MAX_MS).toBe(500);
    expect(log).toEqual(['curtain:on', 'resize:500', 'frame', 'frame', 'curtain:off']);
  });

  it('does nothing when already in the requested mode', async () => {
    const { log, deps } = fake();
    await createFullscreenController(deps)(false);
    expect(log).toEqual([]);
  });

  it('serializes rapid toggles', async () => {
    const { log, deps } = fake();
    const apply = createFullscreenController(deps);
    await Promise.all([apply(true), apply(false)]);
    // One whole cover after the other, never two curtains at once.
    expect(log.filter((entry) => entry.startsWith('curtain:'))).toEqual([
      'curtain:on',
      'curtain:off',
      'curtain:on',
      'curtain:off',
    ]);
    expect(log.indexOf('curtain:off')).toBeLessThan(log.lastIndexOf('curtain:on'));
  });

  it('does not cover a window that is in the mode already when the player opens', async () => {
    const { log, deps } = fake();
    await createFullscreenController(deps, true)(true);
    expect(log).toEqual([]);
  });

  it('takes the curtain down when the wait fails, and goes on with the next switch', async () => {
    const { log, deps } = fake();
    let failures = 1;
    const apply = createFullscreenController({
      ...deps,
      nextFrame: async () => {
        if (failures-- > 0) throw new Error('no frame');
        log.push('frame');
      },
    });

    await expect(apply(true)).rejects.toThrow('no frame');
    expect(log).toContain('curtain:off');

    await apply(false);
    expect(log.filter((entry) => entry === 'curtain:on')).toHaveLength(2);
    expect(log.at(-1)).toBe('curtain:off');
  });
});

describe('the sizes', () => {
  it('osdSize reads the size of mpv’s window, and nothing from what is not one', () => {
    expect(osdSize({ 'osd-dimensions': { w: 1920, h: 1080, ml: 0, mr: 0, mt: 0, mb: 0 } })).toEqual({
      w: 1920,
      h: 1080,
    });
    expect(osdSize({})).toBeNull();
    expect(osdSize({ 'osd-dimensions': null })).toBeNull();
    expect(osdSize({ 'osd-dimensions': { w: 0, h: 0 } })).toBeNull();
    expect(osdSize({ 'osd-dimensions': { w: '1920', h: 1080 } })).toBeNull();
  });

  it('sameSize allows a pixel or two for a fractional display scale', () => {
    expect(sameSize({ w: 1920, h: 1080 }, { w: 1921, h: 1079 })).toBe(true);
    expect(sameSize({ w: 1920, h: 1080 }, { w: 1280, h: 720 })).toBe(false);
    expect(sameSize(null, null)).toBe(true);
    expect(sameSize(null, { w: 1, h: 1 })).toBe(false);
  });
});

describe('waiting for mpv to have the size of the window', () => {
  const realWidth = window.innerWidth;
  const realHeight = window.innerHeight;

  const setWindow = (width: number, height: number) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
  };
  const setOsd = (w: number, h: number) => {
    usePlayerStore.getState().applyChanges({ 'osd-dimensions': { w, h } });
  };
  /** Lets the promises that are ready run. */
  const flush = async () => {
    for (let round = 0; round < 5; round += 1) await Promise.resolve();
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: FAKE });
    usePlayerStore.setState(usePlayerStore.getInitialState(), true);
    vi.stubGlobal('devicePixelRatio', 1);
    setWindow(1000, 600);
    setOsd(1000, 600);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setWindow(realWidth, realHeight);
  });

  it('windowSize is the client area in pixels', () => {
    vi.stubGlobal('devicePixelRatio', 1.5);
    expect(windowSize()).toEqual({ w: 1500, h: 900 });
  });

  it('ends when the window and mpv have both got the new size', async () => {
    let done = false;
    const waiting = waitForResize(CURTAIN_MAX_MS).then(() => {
      done = true;
    });

    // The window is fullscreen; mpv has not caught up.
    setWindow(1920, 1080);
    window.dispatchEvent(new Event('resize'));
    await flush();
    expect(done).toBe(false);

    // mpv's window has the new size: the curtain can go.
    setOsd(1920, 1080);
    await waiting;
    expect(done).toBe(true);
  });

  it('ends when mpv has caught up first and the window follows', async () => {
    let done = false;
    const waiting = waitForResize(CURTAIN_MAX_MS).then(() => {
      done = true;
    });
    setOsd(1920, 1080);
    await flush();
    // Its size is not the window's yet.
    expect(done).toBe(false);

    setWindow(1920, 1080);
    window.dispatchEvent(new Event('resize'));
    await waiting;
    expect(done).toBe(true);
  });

  it('gives up after the time it is given when nothing changes', async () => {
    let done = false;
    const waiting = waitForResize(CURTAIN_MAX_MS).then(() => {
      done = true;
    });

    // A size that matches to begin with is no news: the wait is for a change.
    usePlayerStore.getState().applyChanges({ 'time-pos': 12 });
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(CURTAIN_MAX_MS - 1);
    await flush();
    expect(done).toBe(false);

    vi.advanceTimersByTime(1);
    await waiting;
    expect(done).toBe(true);
  });

  it('stops listening when it is over', async () => {
    const removed = vi.spyOn(window, 'removeEventListener');
    const waiting = waitForResize(CURTAIN_MAX_MS);
    vi.advanceTimersByTime(CURTAIN_MAX_MS);
    await waiting;
    expect(removed).toHaveBeenCalledWith('resize', expect.any(Function));
    removed.mockRestore();
  });
});

describe('useFullscreenCurtain', () => {
  const realWidth = window.innerWidth;
  const realHeight = window.innerHeight;
  const setWindow = (width: number, height: number) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: FAKE });
    usePlayerStore.setState(usePlayerStore.getInitialState(), true);
    vi.stubGlobal('devicePixelRatio', 1);
    setWindow(1000, 600);
    usePlayerStore.getState().applyChanges({ fullscreen: false, 'osd-dimensions': { w: 1000, h: 600 } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setWindow(realWidth, realHeight);
  });

  it('is down from mpv going fullscreen until mpv has the size of the window, and never calls Tauri', async () => {
    const { result } = renderHook(() => useFullscreenCurtain());
    // Starting up is no switch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(result.current).toBe(false);

    await act(async () => {
      usePlayerStore.getState().applyChanges({ fullscreen: true });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(true);

    // Rust switched the window; mpv follows.
    await act(async () => {
      setWindow(1920, 1080);
      window.dispatchEvent(new Event('resize'));
      usePlayerStore.getState().applyChanges({ 'osd-dimensions': { w: 1920, h: 1080 } });
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current).toBe(false);
  });

  it('is down for at most 500 ms, whatever happens', async () => {
    const { result } = renderHook(() => useFullscreenCurtain());
    await act(async () => {
      usePlayerStore.getState().applyChanges({ fullscreen: true });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CURTAIN_MAX_MS + 100);
    });
    expect(result.current).toBe(false);
  });

  it('does not cover a player that opens in a fullscreen window', async () => {
    usePlayerStore.getState().applyChanges({ fullscreen: true });
    const { result } = renderHook(() => useFullscreenCurtain());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(result.current).toBe(false);
  });
});
