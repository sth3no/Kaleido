/**
 * Where a panel (quick settings, the playlist) goes: over the button that opened it, in the middle
 * of the button, and never beyond the window (spec 8.5, point 2). Everything here is in CSS px of
 * the window: whoever calls it measures through `theme/zoom.ts`, so that the UI scale (CSS `zoom`
 * on the root) does not move the panel off its button.
 */

import type { ClientBox } from '../theme/zoom';

export interface Size {
  w: number;
  h: number;
}

/** The air a panel keeps between itself and the edge of the window, px. */
export const PANEL_MARGIN_PX = 8;

/** The air between a panel and the button it stands over, px. */
export const ANCHOR_GAP_PX = 8;

/** `value` held to `min` to `max`; a range too small for it gives `min`. */
const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/**
 * The top left corner of a panel of `size` over `anchor` (a `DOMRect` is one), in a window of
 * `viewport` size.
 *
 * - It is centred over the button and kept inside the window (`PANEL_MARGIN_PX` from every edge);
 *   a panel wider than the window sits at its left edge.
 * - It stands `gap` above the button. When it does not fit above, it goes under the button instead
 *   (and is held inside the window if it fits there no better).
 */
export function placeAbove(
  anchor: ClientBox,
  size: Size,
  viewport: Size,
  gap: number = ANCHOR_GAP_PX,
): { x: number; y: number } {
  const x = clamp(
    anchor.left + anchor.width / 2 - size.w / 2,
    PANEL_MARGIN_PX,
    viewport.w - size.w - PANEL_MARGIN_PX,
  );
  const above = anchor.top - gap - size.h;
  const y = above >= PANEL_MARGIN_PX ? above : anchor.top + anchor.height + gap;
  return { x, y: clamp(y, PANEL_MARGIN_PX, viewport.h - size.h - PANEL_MARGIN_PX) };
}
