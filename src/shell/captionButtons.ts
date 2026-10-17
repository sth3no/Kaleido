/**
 * The window buttons Windows hit-tests itself (src-tauri/src/surface/caption.rs): today the
 * maximise/restore button, whose `HTMAXBUTTON` opens Windows 11's Snap Layouts (spec 5.1). The UI
 * measures it like a glass element, in CSS px of the window at any UI scale, and sends the list
 * when it changed, at most once per frame. A button nobody sees (a faded island) is left out, so
 * that Windows does not keep answering for it.
 */

import type { RefObject } from 'react';

import { createRectSet, useTrackedRect } from '../glass/useGlassRegion';
import { surfaceSetCaptionButtons } from '../ipc/commands';

/**
 * Attempt 1 of the Snap Layouts spike (ruling R36), the one switch for all of it: the islands are
 * WebView2's own caption (CSS `app-region`, the `caption` classes of the island modules), and the
 * maximise button is measured for Windows, which Rust covers with a window that answers
 * `HTMAXBUTTON`. The big manual pass decides (docs/m1/checklist.md).
 *
 * `false` is the fallback: the islands move the window with `data-tauri-drag-region` only (as in
 * M0), Rust is told of no button and puts nothing over it, and the UI's own buttons take every
 * click; Snap Layouts are then reachable with Win+Z only. The switch is here and not in Rust
 * because WebView2 may apply a change of its non-client regions only at the next page load:
 * leaving the CSS out is what turns them off for sure.
 */
export const SNAP_LAYOUTS: boolean = true;

const captionButtons = createRectSet({
  send: (rects) => surfaceSetCaptionButtons(rects.map(({ x, y, w, h }) => ({ x, y, w, h }))),
  what: 'surface_set_caption_buttons',
  // Where it is counts, not how it looks: a fade sends nothing new.
  shape: ({ x, y, w, h }) => ({ x, y, w, h, r: 0, a: 1 }),
});

/**
 * Tells Rust where the maximise/restore button of `ref` is while it is mounted and `active` (and
 * the spike is on).
 */
export function useCaptionButton(ref: RefObject<HTMLElement | null>, active = true): void {
  useTrackedRect(captionButtons, ref, 0, SNAP_LAYOUTS && active);
}
