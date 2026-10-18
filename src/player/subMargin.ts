/**
 * Where the subtitles go while the controls are there (spec 5.3): above the bottom island. mpv
 * measures `sub-margin-y` in a window of 720 px height whatever the window really is, so the
 * island's height in window px is scaled to that. With the controls hidden the UI asks for 0.
 *
 * Rust takes the larger of the margin asked for and the one mpv had before the first request (its
 * own default, 34 in the libmpv Kaleido ships, or the one in the user's mpv.conf;
 * `Engine::set_sub_margin`, Ruling R38): 0 means
 * "nothing of mine is in the way", so the subtitles go back to where the user has them.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';

import { playerCommand } from '../ipc/commands';
import { readZoomFrame, toWindowBox } from '../theme/zoom';

/** The height `sub-margin-y` is measured in; and the greatest margin Rust takes. */
export const SUB_MARGIN_SCALE = 720;

/**
 * Air between the top of the island and the subtitles, in px of the window. The subtitles' own
 * outline and shadow reach beyond the line, and they should not touch the glass.
 */
export const SUB_MARGIN_GAP_PX = 12;

/**
 * The `sub-margin-y` for a band of `islandHeightPx` at the bottom of a window `windowHeightPx`
 * high (both in px of the window): scaled to 720, a whole number, within 0 to 720 (what Rust takes).
 * Nothing to measure, no margin.
 */
export function subMarginFor(islandHeightPx: number, windowHeightPx: number): number {
  if (!(islandHeightPx > 0) || !(windowHeightPx > 0)) return 0;
  const margin = Math.round((islandHeightPx * SUB_MARGIN_SCALE) / windowHeightPx);
  return Math.min(SUB_MARGIN_SCALE, Math.max(0, margin));
}

/**
 * Keeps `sub-margin-y` above the island of `ref` while it is mounted and not `hidden`, and at 0 else
 * (also when it goes away). It sends when the value changes, not per frame: when the island shows or
 * hides, changes its size (the UI scale, a wider window) or the window changes its height, and when
 * the island has arrived (a slide-in moves it while it is measured).
 */
export function useSubMargin(ref: RefObject<HTMLElement | null>, hidden: boolean): void {
  /** What mpv has (or is being sent); `null` before the first send. */
  const sent = useRef<number | null>(null);

  const send = useCallback((margin: number) => {
    if (sent.current === margin) return;
    sent.current = margin;
    playerCommand({ type: 'setSubMargin', margin }).catch((error: unknown) => {
      // mpv does not have it: asked for again at the next change.
      if (sent.current === margin) sent.current = null;
      console.warn('setSubMargin', error);
    });
  }, []);

  useEffect(() => {
    const island = ref.current;
    if (hidden || !island) {
      send(0);
      return undefined;
    }
    const measure = () => {
      const windowHeight = window.innerHeight;
      const box = toWindowBox(island.getBoundingClientRect(), readZoomFrame());
      // From the island's top edge to the bottom of the window, and the air above it.
      send(subMarginFor(windowHeight - box.top + SUB_MARGIN_GAP_PX, windowHeight));
    };
    measure();
    // Not in the tests' jsdom.
    const resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    resizes?.observe(island);
    window.addEventListener('resize', measure);
    // The island slides in, and while it does it sits a few px low: measured again where it stops.
    const arrived = (e: Event) => {
      if (e.target === island) measure();
    };
    island.addEventListener('transitionend', arrived);
    return () => {
      resizes?.disconnect();
      window.removeEventListener('resize', measure);
      island.removeEventListener('transitionend', arrived);
    };
  }, [ref, hidden, send]);

  // The island is gone (the video ended, the page changed): nothing is above the subtitles.
  useEffect(
    () => () => {
      send(0);
    },
    [send],
  );
}
