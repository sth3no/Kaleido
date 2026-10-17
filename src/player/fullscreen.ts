/**
 * The black curtain over the window while it switches to or from fullscreen (spec 5.1), ported from
 * the M0 prototype. Until mpv has drawn its first frame in the new size the window shows a stretched
 * or half-drawn picture; the curtain hides that.
 *
 * Unlike in M0 the UI does not switch the window: Rust follows mpv's `fullscreen` property and does
 * it itself, so the UI neither calls Tauri's `setFullscreen` nor sets the mode. It sees the property
 * change (the button, a double click on the video and the keys of input.conf all go through mpv) and
 * covers the switch until `osd-dimensions` (the size of mpv's window) is the size of the window again.
 */

import { useEffect, useMemo, useState } from 'react';

import { usePlayerStore, type PlayerProps } from '../state/playerStore';

/** The longest the curtain stays, whatever happens (a switch that changes no size ends here). */
export const CURTAIN_MAX_MS = 500;

export interface FullscreenDeps {
  setCurtain(on: boolean): void;
  nextFrame(): Promise<void>;
  /** Resolves when mpv has the size of the new window, or after `timeoutMs`. */
  waitForResize(timeoutMs: number): Promise<void>;
}

/**
 * Covers the switch to the mode it is called with. Calls queue up, so that fast toggles curtain
 * one switch after the other; a call for the mode the window is in does nothing. `initial` is the
 * mode the window is in before the first call.
 */
export function createFullscreenController(
  deps: FullscreenDeps,
  initial = false,
): (on: boolean) => Promise<void> {
  let current = initial;
  let queue: Promise<void> = Promise.resolve();
  return (on) => {
    const run = queue.then(async () => {
      if (on === current) return;
      current = on;
      deps.setCurtain(true);
      // The wait starts now, so that it sees the sizes as they are before the switch and not a
      // frame later, when the window may have changed already.
      const resized = deps.waitForResize(CURTAIN_MAX_MS);
      try {
        // The curtain has been drawn before the window changes size under it.
        await deps.nextFrame();
        await resized;
        // And the first frame in the new size has been shown.
        await deps.nextFrame();
      } finally {
        deps.setCurtain(false);
      }
    });
    // One failed switch does not stop the ones after it.
    queue = run.catch(() => undefined);
    return run;
  };
}

export const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });

export interface Size {
  w: number;
  h: number;
}

/** The size of mpv's window in pixels (`osd-dimensions`), `null` while mpv has none. */
export function osdSize(props: PlayerProps): Size | null {
  const osd = props['osd-dimensions'];
  if (typeof osd !== 'object' || osd === null) return null;
  const { w, h } = osd as Record<string, unknown>;
  return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { w, h } : null;
}

/** The window's client area in pixels: what mpv's window is when it fills it. */
export function windowSize(): Size {
  const scale = window.devicePixelRatio || 1;
  return { w: Math.round(window.innerWidth * scale), h: Math.round(window.innerHeight * scale) };
}

/** Whether two sizes are the same, to a pixel or two (the rounding of a fractional display scale). */
export function sameSize(a: Size | null, b: Size | null, tolerance = 2): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a.w - b.w) <= tolerance && Math.abs(a.h - b.h) <= tolerance;
}

/**
 * Resolves when mpv's window is the size of the window again after one of them has changed since
 * this was called (the switch), or after `timeoutMs`. It cannot tell a switch that changes nothing
 * from one that has not started: both end at the timeout.
 */
export function waitForResize(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const osdAtStart = osdSize(usePlayerStore.getState().props);
    const windowAtStart = windowSize();

    // Called later than the three constants below are set.
    function finish(): void {
      clearTimeout(timer);
      stopStore();
      window.removeEventListener('resize', check);
      resolve();
    }
    function check(): void {
      const osd = osdSize(usePlayerStore.getState().props);
      const now = windowSize();
      const moved = !sameSize(osd, osdAtStart) || !sameSize(now, windowAtStart);
      if (moved && osd !== null && sameSize(osd, now)) finish();
    }

    const timer = setTimeout(finish, timeoutMs);
    const stopStore = usePlayerStore.subscribe((state, previous) => {
      if (state.props['osd-dimensions'] !== previous.props['osd-dimensions']) check();
    });
    window.addEventListener('resize', check);
  });
}

/** Whether the curtain is down: follows mpv's `fullscreen` property. */
export function useFullscreenCurtain(): boolean {
  const fullscreen = usePlayerStore((state) => state.props['fullscreen'] === true);
  const [curtain, setCurtain] = useState(false);
  const cover = useMemo(
    () =>
      createFullscreenController(
        { setCurtain, nextFrame, waitForResize },
        // A video that opens in a window that is fullscreen already is no switch.
        usePlayerStore.getState().props['fullscreen'] === true,
      ),
    [],
  );
  useEffect(() => {
    cover(fullscreen).catch((error: unknown) => {
      console.warn('the fullscreen curtain', error);
    });
  }, [cover, fullscreen]);
  return curtain;
}
