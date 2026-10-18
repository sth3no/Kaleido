/**
 * The mini player's geometry (spec 8.3, 8.6), ported from the M0 prototype: where the video goes
 * in the corner, and the rectangles of the animation between there and the whole window.
 *
 * Every rectangle here is in CSS px of the window, the frame Rust's `Layout` is in
 * (src-tauri/src/surface/layout.rs). The shell cuts its hole for the video and places the mini
 * player's frame by the same numbers, so that both are where mpv's window is; the frame converts
 * them to its own px under the UI scale (`theme/zoom.ts`).
 */

import type { Layout } from '../ipc/types';

export type Rect = { x: number; y: number; w: number; h: number };

/** The mini player at rest, as Rust takes it. */
export type MiniLayout = Extract<Layout, { kind: 'mini' }>;

/**
 * The mini player (key-screens and pages-navigation mockups): 360 px wide, 16 px from the
 * window's right and bottom edges. In the UI's own CSS px: they grow with the UI scale, as every
 * other length of the UI does.
 */
export const MINI = { w: 360, right: 16, bottom: 16 } as const;

/** The video's shape until mpv has said (`video-params`), and for a file with no picture. */
export const DEFAULT_ASPECT = 16 / 9;

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

export const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t,
  h: a.h + (b.h - a.h) * t,
});

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const positive = (value: unknown): number | undefined => {
  const number = finite(value);
  return number !== undefined && number > 0 ? number : undefined;
};

/**
 * The shape the video is shown with, width over height, from mpv's `video-params`: the display
 * size (`dw` × `dh`, with the pixel aspect), else `aspect`, else the stored size; turned on its side
 * for a rotation of 90 or 270 degrees. 16:9 while there is none.
 */
export function videoAspect(params: unknown): number {
  if (typeof params !== 'object' || params === null) return DEFAULT_ASPECT;
  const { dw, dh, aspect, w, h, rotate } = params as Record<string, unknown>;
  const displayW = positive(dw);
  const displayH = positive(dh);
  const storedW = positive(w);
  const storedH = positive(h);
  const shape =
    displayW !== undefined && displayH !== undefined
      ? displayW / displayH
      : (positive(aspect) ??
        (storedW !== undefined && storedH !== undefined ? storedW / storedH : undefined));
  if (shape === undefined) return DEFAULT_ASPECT;
  const turned = Math.abs(finite(rotate) ?? 0) % 180 === 90;
  return turned ? 1 / shape : shape;
}

/**
 * The layout Rust gets for the mini player at rest, in CSS px of the window at the UI scale
 * `zoom`: `MINI.w` wide and as high as the video's `aspect` makes it (4:3 is 360 × 270), whole px
 * of the UI. A portrait video gets that size as its height instead, so that it does not take the
 * window's height.
 */
export function miniLayout(aspect: number, zoom = 1): MiniLayout {
  const shape = Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT;
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const [w, h] =
    shape >= 1 ? [MINI.w, Math.round(MINI.w / shape)] : [Math.round(MINI.w * shape), MINI.w];
  return {
    kind: 'mini',
    w: w * scale,
    h: h * scale,
    right: MINI.right * scale,
    bottom: MINI.bottom * scale,
  };
}

/**
 * Where Rust puts `layout` in a window `viewW` × `viewH` CSS px: its bottom-right corner `right`
 * and `bottom` from the window's. A window too small for it keeps the margins on all four sides
 * and gets a smaller one with the same shape, never a squashed one. The same rule as `to_physical`
 * in src-tauri/src/surface/layout.rs, which keeps the hole on mpv's window: change both together.
 * `null` when nothing of it fits.
 */
export function miniRect(layout: MiniLayout, viewW: number, viewH: number): Rect | null {
  if (!(layout.w > 0 && layout.h > 0 && viewW > 0 && viewH > 0)) return null;
  const right = Math.max(0, layout.right);
  const bottom = Math.max(0, layout.bottom);
  const fit = Math.min((viewW - 2 * right) / layout.w, (viewH - 2 * bottom) / layout.h, 1);
  const w = layout.w * fit;
  const h = layout.h * fit;
  if (!(w > 0 && h > 0)) return null;
  return { x: viewW - right - w, y: viewH - bottom - h, w, h };
}

/** What `animateRect` runs on: the browser's clock and frames, or a test's. */
export interface FrameClock {
  now: () => number;
  request: (run: () => void) => number;
  cancel: (id: number) => void;
}

export const BROWSER_CLOCK: FrameClock = {
  now: () => performance.now(),
  request: (run) => requestAnimationFrame(() => run()),
  cancel: (id) => {
    cancelAnimationFrame(id);
  },
};

/**
 * Runs one rectangle animation: `onFrame` once per animation frame for `ms`, eased (ease-out
 * cubic), and the last frame exactly `to`; then `onDone`. The UI's frame and mpv's window follow
 * the same values (spec 8.6). Returns the function that stops it: no frame and no `onDone` after
 * that. Nothing is asked of the browser once it is done or stopped (spec 13: no work per frame at
 * rest).
 */
export function animateRect(
  from: Rect,
  to: Rect,
  ms: number,
  onFrame: (rect: Rect) => void,
  onDone: () => void = () => undefined,
  clock: FrameClock = BROWSER_CLOCK,
): () => void {
  const start = clock.now();
  let id: number | null = null;
  let stopped = false;
  const step = () => {
    id = null;
    if (stopped) return;
    const t = ms > 0 ? Math.min(1, (clock.now() - start) / ms) : 1;
    onFrame(t >= 1 ? to : lerpRect(from, to, easeOutCubic(t)));
    if (stopped) return;
    if (t < 1) {
      id = clock.request(step);
    } else {
      stopped = true;
      onDone();
    }
  };
  id = clock.request(step);
  return () => {
    stopped = true;
    if (id !== null) clock.cancel(id);
    id = null;
  };
}
