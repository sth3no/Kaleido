/**
 * The shell of the panels above the controls (spec 8.5, point 2; 8.9): a glass dialog that stands
 * over the button that opened it (`placeAbove`), opens with a short spring and gives the focus
 * back to the button when it goes.
 *
 * - It is a child of the body and `position: fixed`, so that nothing of the island it was opened
 *   from (its glass, its slide) carries it along or becomes its containing block. The UI scale is
 *   `zoom` on the root: the button and the panel are measured in px of the window
 *   (`theme/zoom.ts`) and the panel's `left` and `top` are given in its own px (window px / zoom).
 *   Measured again when the window or the scale changes, and when the panel's size does.
 * - The focus goes in when it opens (to the `data-autofocus` element, else the first one Tab
 *   reaches) and stays in: Tab and Shift+Tab go round, and focus that lands outside is brought
 *   back. When the panel goes with the focus in it, the focus returns to the button.
 * - Esc closes it. A press anywhere else closes it too; a press on the bare video (the layer
 *   `data-video-layer`) does nothing else, so that closing a panel does not also pause the video.
 * - The keys it handles call `preventDefault`, so that `input/forward.ts` does not also send them
 *   to mpv (Esc would leave fullscreen there). While the focus is in the panel the arrows, Home,
 *   End and the page keys are the panel's: what a list does not take itself is swallowed here, so
 *   that an arrow on a button does not seek or change the volume behind the panel (a slider keeps
 *   its own keys, which are not forwarded anyway).
 * - It is glass over the video: one of the regions the shader blurs (opaque when the glass is
 *   off), and an island for the autohide, so that the pointer on it holds the controls.
 *
 * It opens with a transition (`@starting-style`), not a keyframe animation; with reduced motion
 * only the fade is left (theme/global.css). It goes without one: the focus and the controls are
 * where the user left them at once.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type TransitionEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { glassRegions, useGlassRegion } from '../glass/useGlassRegion';
import glass from '../theme/glass.module.css';
import { readZoomFrame, toWindowBox } from '../theme/zoom';
import { PANEL_MARGIN_PX, placeAbove } from './placement';
import styles from './Popover.module.css';

export interface PopoverProps {
  /** The button that opened it: the panel stands over it, and the focus goes back to it. */
  anchor: RefObject<HTMLElement | null>;
  /** What the dialog is called, for screen readers. */
  label: string;
  /** Esc, or a press outside, asks for the panel to be closed. */
  onClose: () => void;
  /** Sets the width and the tallest it may be (`--popover-max-h`). */
  className?: string;
  children: ReactNode;
}

/** What Tab can reach (the elements that can take the focus at all). */
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]';

/** The elements Tab reaches inside `root`, in document order. */
export function tabbablesOf(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hasAttribute('disabled') &&
      element.closest('[inert], [hidden]') === null,
  );
}

/** The keys that move through a list or a slider: the panel's while the focus is in it. */
const NAVIGATION_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/** Sets the panel over (or, when it does not fit, under) its button, inside the window. */
function place(panel: HTMLElement, anchor: HTMLElement): void {
  const frame = readZoomFrame();
  const windowSize = { w: window.innerWidth, h: window.innerHeight };
  // The most it may take of the window, in its own px: what a long list scrolls inside.
  panel.style.setProperty('--popover-fit-w', `${Math.max(0, windowSize.w - 2 * PANEL_MARGIN_PX) / frame.zoom}px`);
  panel.style.setProperty('--popover-fit-h', `${Math.max(0, windowSize.h - 2 * PANEL_MARGIN_PX) / frame.zoom}px`);
  const box = toWindowBox(panel.getBoundingClientRect(), frame);
  const { x, y } = placeAbove(
    toWindowBox(anchor.getBoundingClientRect(), frame),
    { w: box.width, h: box.height },
    windowSize,
  );
  panel.style.left = `${x / frame.zoom}px`;
  panel.style.top = `${y / frame.zoom}px`;
  // Moved by script, not by a transition: the glass under it is measured again by hand.
  glassRegions.schedule();
}

export default function Popover({ anchor, label, onClose, className, children }: PopoverProps) {
  const panel = useRef<HTMLDivElement>(null);
  /** Where the focus was last inside, for bringing it back. */
  const lastFocus = useRef<HTMLElement | null>(null);
  /** The focus is being handed to the button on purpose: the guard below lets it go. */
  const leaving = useRef(false);
  const closeRef = useRef(onClose);
  useGlassRegion(panel);

  useLayoutEffect(() => {
    closeRef.current = onClose;
  });

  const returnFocus = useCallback(() => {
    leaving.current = true;
    try {
      anchor.current?.focus({ preventScroll: true });
    } finally {
      leaving.current = false;
    }
  }, [anchor]);

  const placeNow = useCallback(() => {
    const element = panel.current;
    const button = anchor.current;
    if (element && button?.isConnected) place(element, button);
  }, [anchor]);

  // Over its button at every render (the content, and so the size, may have changed) and whenever
  // the window, the UI scale or the panel itself changes size.
  useLayoutEffect(() => {
    placeNow();
  });
  useEffect(() => {
    const element = panel.current;
    if (!element) return undefined;
    window.addEventListener('resize', placeNow);
    // The UI scale is a variable on the root element (theme/useAppearance.ts).
    const root = new MutationObserver(placeNow);
    root.observe(document.documentElement, { attributes: true });
    const resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(placeNow) : null;
    resizes?.observe(element);
    return () => {
      window.removeEventListener('resize', placeNow);
      root.disconnect();
      resizes?.disconnect();
    };
  }, [placeNow]);

  // The focus goes in.
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const first = element.querySelector<HTMLElement>('[data-autofocus]') ?? tabbablesOf(element)[0];
    (first ?? element).focus({ preventScroll: true });
  }, []);

  // And back to the button when the panel goes with the focus in it (or nowhere: an entry that
  // had it went away). Not when the user has moved on to something else.
  useLayoutEffect(() => {
    const element = panel.current;
    return () => {
      const active = document.activeElement;
      if (element && (active === null || active === document.body || element.contains(active))) {
        returnFocus();
      }
    };
  }, [returnFocus]);

  // Esc, the keeping of the focus and the press outside.
  useEffect(() => {
    const element = panel.current;
    if (!element) return undefined;
    const abort = new AbortController();
    const { signal } = abort;

    const bringBack = () => {
      const last = lastFocus.current;
      const target = last?.isConnected && element.contains(last) ? last : tabbablesOf(element)[0];
      (target ?? element).focus({ preventScroll: true });
    };

    document.addEventListener(
      'keydown',
      (e) => {
        if (e.defaultPrevented || e.isComposing) return;
        if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
          // Handled here: mpv does not get Esc (it would leave fullscreen).
          e.preventDefault();
          returnFocus();
          closeRef.current();
          return;
        }
        if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
        const items = tabbablesOf(element);
        const first = items[0];
        const last = items.at(-1);
        if (!first || !last) {
          e.preventDefault();
          element.focus({ preventScroll: true });
          return;
        }
        const active = document.activeElement;
        if (!active || !element.contains(active) || active === element) {
          // The focus is not in a control of the panel (a click on its background, a removed
          // entry): it goes to the end Tab was heading for.
          e.preventDefault();
          (e.shiftKey ? last : first).focus({ preventScroll: true });
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus({ preventScroll: true });
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus({ preventScroll: true });
        }
      },
      { signal },
    );

    // Focus that lands outside (script, the button itself) comes back in.
    document.addEventListener(
      'focusin',
      (e) => {
        const target = e.target;
        if (leaving.current || !(target instanceof Node) || element.contains(target)) return;
        bringBack();
      },
      { signal },
    );

    // Before anything below sees the press: on the capture of the window.
    window.addEventListener(
      'pointerdown',
      (e) => {
        const target = e.target;
        if (!(target instanceof Node)) return;
        // Inside, or on the button, whose click opens, switches or closes the panel.
        if (element.contains(target) || anchor.current?.contains(target)) return;
        if (target instanceof Element && target.closest('[data-video-layer]')) {
          e.preventDefault();
          e.stopPropagation();
        }
        closeRef.current();
      },
      { signal, capture: true },
    );

    return () => {
      abort.abort();
    };
  }, [anchor, returnFocus]);

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLElement && e.target !== e.currentTarget) lastFocus.current = e.target;
  };

  // The rect set follows the transitions that start after the panel joined it; one that began
  // before (the panel is measured while it opens) is caught here, where it ends.
  const onTransitionEnd = (e: TransitionEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) glassRegions.schedule();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || !NAVIGATION_KEYS.has(e.key)) return;
    // A slider moves with these keys itself; the browser must keep them for it.
    if (e.target instanceof HTMLInputElement) return;
    e.preventDefault();
  };

  const look = className ? `${glass.glass} ${styles.popover} ${className}` : `${glass.glass} ${styles.popover}`;

  return createPortal(
    <div
      ref={panel}
      className={look}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      data-island
      data-popover
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onTransitionEnd={onTransitionEnd}
    >
      {children}
    </div>,
    document.body,
  );
}
