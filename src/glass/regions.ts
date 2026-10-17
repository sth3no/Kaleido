/**
 * Measuring the glass elements for the shader in mpv (spec 8.2), ported from the M0 prototype.
 * The rectangles are CSS px of the window whatever the UI scale (`theme/zoom.ts`); Rust multiplies
 * them by the display scale.
 */

import type { GlassRect } from '../ipc/types';
import { NO_ZOOM, toWindowBox, toWindowLength, type ClientBox, type ZoomFrame } from '../theme/zoom';

export type { GlassRect };

/** Regions the shader blurs at once; must match `glass::MAX_REGIONS` in Rust. */
export const MAX_REGIONS = 6;

/** What `measure` reads of an element. */
export interface Measurable {
  getBoundingClientRect(): ClientBox;
  /** The element's effective zoom, where the engine has it (Chromium 128 and up). */
  readonly currentCSSZoom?: number;
}

/** What `measure` reads of the element's computed style. */
export interface StyleLike {
  borderTopLeftRadius: string;
  opacity: string;
  visibility?: string;
}

export interface MeasureOptions {
  /** How the UI scale reaches the numbers; none by default. */
  frame?: ZoomFrame;
  /** The corner radius in the element's own CSS px; else its `border-top-left-radius`. */
  radius?: number;
  /** The opacity it shows with (its ancestors' included); else its own. */
  opacity?: number;
}

/** A computed CSS opacity; one that is no number (an engine that does not compute it) is fully opaque. */
export function opacityOf(value: string): number {
  const opacity = Number.parseFloat(value);
  return Number.isFinite(opacity) ? opacity : 1;
}

/**
 * The glass rectangle of an element: its box, its corner radius (at most half its shorter side)
 * and its opacity, which fades the blur with the element. `null` for an element that shows
 * nothing: empty, hidden or (nearly) fully transparent.
 */
export function measure(el: Measurable, style: StyleLike, options: MeasureOptions = {}): GlassRect | null {
  const frame = options.frame ?? NO_ZOOM;
  const box = toWindowBox(el.getBoundingClientRect(), frame);
  const alpha = options.opacity ?? opacityOf(style.opacity);
  if (style.visibility === 'hidden' || box.width < 1 || box.height < 1 || !(alpha > 0.01)) return null;
  const own = options.radius ?? (Number.parseFloat(style.borderTopLeftRadius) || 0);
  const radius = Math.min(toWindowLength(own, frame, el.currentCSSZoom), box.width / 2, box.height / 2);
  return { x: box.left, y: box.top, w: box.width, h: box.height, r: radius, a: Math.min(1, alpha) };
}

/** Half-pixel steps and whole percents: what makes a visible difference. */
const key = (r: GlassRect) =>
  `${[r.x, r.y, r.w, r.h, r.r].map((v) => Math.round(v * 2)).join(',')}:${Math.round((r.a ?? 1) * 100)}`;

/** Whether two lists show the same glass: sub-pixel jitter is no change. */
export function sameRects(a: readonly GlassRect[], b: readonly GlassRect[]): boolean {
  return a.length === b.length && a.every((r, i) => {
    const other = b[i];
    return other !== undefined && key(r) === key(other);
  });
}
