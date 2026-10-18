/**
 * Where mpv's window is (spec 8.3, 8.6): the whole window on the player page, the mini player in
 * the bottom-right corner on any other page while a file is open, and the animation between the
 * two. It sends Rust the layout (`surfaceSetLayout`) and tells the shell where the video is, so
 * that the shell cuts its hole in the page and draws the mini player's frame on the same numbers.
 *
 * - Into the mini player: a `rect` frame every animation frame for `motion.slow` (250 ms), eased,
 *   from the whole window to the corner; then the docked `mini` layout, which Rust keeps in its
 *   corner while the window is resized. Back to the player: the same frames the other way, then
 *   `full`. Turning round half-way starts from where the video is.
 * - Reduced motion (Windows' animations are off): nothing moves. `hidden`, then `mini` at once, and
 *   the frame fades in (spec 8.6; also the M0 fallback for point 6). Back: `hidden`, then `full`.
 * - A file that opens while another page is shown has no big picture to shrink from: it comes up
 *   in the corner the reduced-motion way. One that closes is gone at once: `full`, which the opaque
 *   page covers.
 * - The animation's frames are asked for only while it runs. At rest nothing runs per frame (spec
 *   13): the docked rectangle is worked out again only when the window is resized, the UI scale
 *   changes or the video gets another shape, and Rust is told only when the layout changed.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { surfaceSetLayout } from '../ipc/commands';
import type { Layout } from '../ipc/types';
import { selectVideoOpen } from '../shell/view';
import { usePlayerStore } from '../state/playerStore';
import { useUiStore } from '../state/uiStore';
import { defaultTokens } from '../theme/tokens';
import { readZoomFrame } from '../theme/zoom';
import { animateRect, miniLayout, miniRect, videoAspect, type MiniLayout, type Rect } from './mini';

/** How long the video takes into the corner and back: the `motion.slow` token. */
export const MINI_MOTION_MS = defaultTokens('dark').motion.slow;

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * - `full`: mpv's window fills the window.
 * - `shrinking`, `growing`: the animation into the corner, and back.
 * - `mini`: docked in the corner.
 */
export type SurfacePhase = 'full' | 'shrinking' | 'mini' | 'growing';

export interface SurfaceState {
  phase: SurfacePhase;
  /**
   * Where the video is, in CSS px of the window; `null` while it fills the window, and while
   * docked in a window too small for any mini player.
   */
  rect: Rect | null;
  /** The mini player came up without moving: its frame fades in. */
  fade: boolean;
}

const FULL: SurfaceState = { phase: 'full', rect: null, fade: false };

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches;
}

/** The window in CSS px, and the UI scale. */
function readViewport(): { w: number; h: number; zoom: number } {
  return { w: window.innerWidth, h: window.innerHeight, zoom: readZoomFrame().zoom };
}

function send(layout: Layout): void {
  surfaceSetLayout(layout).catch((error: unknown) => {
    console.warn('surface_set_layout', layout.kind, error);
  });
}

const sameLayout = (a: MiniLayout | null, b: MiniLayout | null): boolean =>
  a !== null &&
  b !== null &&
  a.w === b.w &&
  a.h === b.h &&
  a.right === b.right &&
  a.bottom === b.bottom;

const sameRect = (a: Rect | null, b: Rect | null): boolean =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/** Moves mpv's window for the page and the file (see the top of the file). For the shell, once. */
export function useSurfaceLayout(): SurfaceState {
  const onOtherPage = useUiStore((state) => state.page !== 'player');
  const open = usePlayerStore(selectVideoOpen);
  const aspect = usePlayerStore((state) => videoAspect(state.props['video-params']));
  const mini = onOtherPage && open;
  const [state, setState] = useState<SurfaceState>(FULL);

  /** mpv's window fills the window (or is about to: `full` is on its way). */
  const full = useRef(true);
  /** Where mpv's window is now, when it does not fill the window. */
  const shown = useRef<Rect | null>(null);
  /** The docked layout Rust has. */
  const docked = useRef<MiniLayout | null>(null);
  /** Stops the animation that runs. */
  const stop = useRef<(() => void) | null>(null);
  /** Whether a file was open the last time the page or the file changed. */
  const wasOpen = useRef(open);
  /** The video's shape now, for the transitions (which do not run again when it changes). */
  const shape = useRef(aspect);
  useLayoutEffect(() => {
    shape.current = aspect;
  }, [aspect]);

  // Rust starts with the whole window, and a UI that reloads finds it however it was left: the
  // whole window, as this starts. Before the transitions below, which may follow at once.
  useLayoutEffect(() => {
    send({ kind: 'full' });
    return () => {
      stop.current?.();
      stop.current = null;
    };
  }, []);

  // Before the paint: the page that changed is never shown for a frame with the video where it
  // was (an opaque page over it with no hole yet, or a hole where the video has gone).
  useLayoutEffect(() => {
    const appeared = !wasOpen.current;
    wasOpen.current = open;
    stop.current?.();
    stop.current = null;
    const view = readViewport();
    const whole: Rect = { x: 0, y: 0, w: view.w, h: view.h };

    const frames = (phase: 'shrinking' | 'growing') => (rect: Rect) => {
      shown.current = rect;
      send({ kind: 'rect', ...rect });
      setState({ phase, rect, fade: false });
    };

    if (mini) {
      full.current = false;
      const layout = miniLayout(shape.current, view.zoom);
      const target = miniRect(layout, view.w, view.h);
      const dock = (fade: boolean) => {
        docked.current = layout;
        shown.current = target;
        send(layout);
        setState({ phase: 'mini', rect: target, fade });
      };
      if (prefersReducedMotion() || appeared || target === null) {
        send({ kind: 'hidden' });
        dock(true);
        return;
      }
      const from = shown.current ?? whole;
      setState({ phase: 'shrinking', rect: from, fade: false });
      stop.current = animateRect(from, target, MINI_MOTION_MS, frames('shrinking'), () => {
        stop.current = null;
        dock(false);
      });
      return;
    }

    if (full.current) return;
    const finish = () => {
      full.current = true;
      shown.current = null;
      docked.current = null;
      send({ kind: 'full' });
      setState(FULL);
    };
    // The file closed: nothing to grow, and the page that stays is opaque again.
    if (!open) {
      finish();
      return;
    }
    const from = shown.current;
    if (prefersReducedMotion() || from === null) {
      send({ kind: 'hidden' });
      finish();
      return;
    }
    setState({ phase: 'growing', rect: from, fade: false });
    stop.current = animateRect(from, whole, MINI_MOTION_MS, frames('growing'), () => {
      stop.current = null;
      finish();
    });
  }, [mini, open]);

  // Docked: the corner follows the window, the UI scale and the video's shape. Rust moves mpv's
  // window with the window by itself; the hole needs the new rectangle, and Rust a new layout
  // only when the size changed.
  const atRest = state.phase === 'mini';
  useEffect(() => {
    if (!atRest) return undefined;
    const update = () => {
      // The video is leaving the corner; these listeners go with the next render.
      if (full.current || stop.current !== null) return;
      const view = readViewport();
      const layout = miniLayout(aspect, view.zoom);
      if (!sameLayout(layout, docked.current)) {
        docked.current = layout;
        send(layout);
      }
      const rect = miniRect(layout, view.w, view.h);
      shown.current = rect;
      setState((current) =>
        current.phase !== 'mini' || sameRect(current.rect, rect) ? current : { ...current, rect },
      );
    };
    update();
    window.addEventListener('resize', update);
    // The UI scale is a variable on the root's style (theme/useAppearance.ts).
    const root = new MutationObserver(update);
    root.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => {
      window.removeEventListener('resize', update);
      root.disconnect();
    };
  }, [atRest, aspect]);

  return state;
}
