/**
 * The UI scale (spec 8.9) is CSS `zoom` on the root element (global.css). What the UI measures for
 * Rust (the glass regions, the window buttons Windows hit-tests itself) has to be in CSS px of the
 * window whatever the zoom; this module is the one place that converts.
 *
 * Two things matter:
 * - The zoom itself. A length in the element's own CSS (a border radius as `getComputedStyle`
 *   gives it) is `zoom` times larger on the screen.
 * - What `getBoundingClientRect` reports. With Chromium's standardized zoom (Chromium 128 and up;
 *   WebView2 is evergreen, so this is the normal case) it is CSS px of the window already. Older
 *   engines report the rectangle in the zoomed element's own px, `zoom` times too small. Which one
 *   it is, is read off the root: the root fills the window, so in window px it is as wide as the
 *   window, and in its own px `zoom` times narrower.
 */

/** How the root's zoom reaches what an element reports. */
export interface ZoomFrame {
  /** The UI scale on the root, 0.9 to 1.5; 1 for none. */
  zoom: number;
  /** `getBoundingClientRect` reports CSS px of the window (standardized zoom). */
  rectsInWindowPx: boolean;
}

/** No zoom: everything is in CSS px of the window as it is. */
export const NO_ZOOM: ZoomFrame = { zoom: 1, rectsInWindowPx: true };

/** A rectangle as `getBoundingClientRect` gives it (`DOMRect` is one). */
export interface ClientBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The frame for a root with `zoom` that measures `rootWidth` in a window `windowWidth` wide (both
 * as the engine reports them). A zoom that is no number, or 1, is no zoom.
 */
export function zoomFrame(zoom: number, rootWidth: number, windowWidth: number): ZoomFrame {
  if (!Number.isFinite(zoom) || zoom <= 0 || zoom === 1) return NO_ZOOM;
  // Nothing to compare (not laid out yet): the engine of today.
  if (!(rootWidth > 0) || !(windowWidth > 0)) return { zoom, rectsInWindowPx: true };
  // Whichever reading is nearer: the root as wide as the window, or `zoom` times narrower.
  const asWindowPx = Math.abs(rootWidth - windowWidth);
  const asOwnPx = Math.abs(rootWidth * zoom - windowWidth);
  return { zoom, rectsInWindowPx: asWindowPx <= asOwnPx };
}

/** The frame of the document now. Cheap: one style read, and one layout read only when zoomed. */
export function readZoomFrame(root: HTMLElement = document.documentElement): ZoomFrame {
  const zoom = Number.parseFloat(getComputedStyle(root).getPropertyValue('zoom'));
  if (!Number.isFinite(zoom) || zoom === 1) return NO_ZOOM;
  return zoomFrame(zoom, root.getBoundingClientRect().width, window.innerWidth);
}

/** `box`, as `getBoundingClientRect` reported it, in CSS px of the window. */
export function toWindowBox(box: ClientBox, frame: ZoomFrame): ClientBox {
  const k = frame.rectsInWindowPx ? 1 : frame.zoom;
  return { left: box.left * k, top: box.top * k, width: box.width * k, height: box.height * k };
}

/**
 * The other way: a length in CSS px of the window as a length of an element's own CSS (its
 * `left`, `width`, a radius), for an element under the root's zoom and no other. Whatever the
 * engine reports rectangles in, the element's own px are `zoom` window px.
 */
export function toOwnLength(windowLength: number, frame: ZoomFrame): number {
  return windowLength / frame.zoom;
}

/**
 * A length of the element's own CSS (a border radius from `getComputedStyle`) in CSS px of the
 * window. `elementZoom` is the element's own effective zoom where the engine reports it
 * (`currentCSSZoom`); else the root's.
 */
export function toWindowLength(length: number, frame: ZoomFrame, elementZoom?: number): number {
  const zoom = elementZoom !== undefined && elementZoom > 0 ? elementZoom : frame.zoom;
  return length * zoom;
}
