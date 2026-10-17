/**
 * The islands and the cursor hide after 2.5 s without movement while the video plays (spec 8.4);
 * any movement of the pointer or any key shows them again at once. They stay while:
 *
 * - a panel is open above the controls, or the sidebar is (something to use is on the screen);
 * - the pointer is over an island, or an island has the focus (an element with `data-island`).
 *
 * The islands are hidden by `hidden` (the bottom island) and `uiStore.controlsHidden` (the shell's
 * own); the cursor by `cursor: none` on the root element.
 *
 * Windows' own window over the maximise button (Snap Layouts, src-tauri/src/surface/caption.rs)
 * sits above the page: the page sees no pointer over that button, and WebView2 says the pointer
 * left the page. That must not count as the pointer leaving the islands, or the window buttons
 * would hide under the pointer. So a leave is told by where it happened: out through the edge of
 * the window the pointer is gone; anywhere in the window it is on something that covers the page,
 * and the state from before stays. Moves, not leaves, are what keeps the timer going.
 */

import { useEffect, useRef, useState } from 'react';

import { selectPlaying, usePlayerStore } from '../state/playerStore';
import { useUiStore } from '../state/uiStore';

export const AUTOHIDE_MS = 2500;

/** What counts as an island for the pointer and the focus. */
export const ISLAND_SELECTOR = '[data-island]';

function inIsland(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(ISLAND_SELECTOR) !== null;
}

/** Whether the pointer is over an island now, where the browser can say (before any movement). */
function hoveringIsland(): boolean {
  try {
    return document.querySelector(`${ISLAND_SELECTOR}:hover`) !== null;
  } catch {
    return false;
  }
}

/** Whether a `pointerleave` took the pointer out of the window (rather than onto something over the page). */
export function leftWindow(x: number, y: number): boolean {
  return !(x >= 1 && y >= 1 && x <= window.innerWidth - 2 && y <= window.innerHeight - 2);
}

export interface AutohideOptions {
  ms: number;
  /** The islands are hidden (`true`) or shown (`false`). Called when that changes. */
  onChange: (hidden: boolean) => void;
}

export interface Autohide {
  /** Whether the islands may hide now: the video plays and nothing is open. Else they are shown. */
  setActive: (active: boolean) => void;
  /** Stops listening. */
  destroy: () => void;
}

/** The timer and the events behind `useAutohide`, apart from React. */
export function createAutohide({ ms, onChange }: AutohideOptions): Autohide {
  let active = false;
  let hidden = false;
  let overIsland = hoveringIsland();
  let focusInIsland = inIsland(document.activeElement);
  let x = Number.NaN;
  let y = Number.NaN;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const held = () => overIsland || focusInIsland;

  const setHidden = (value: boolean) => {
    if (hidden === value) return;
    hidden = value;
    onChange(value);
  };

  const disarm = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  /** Starts the 2.5 s anew. They are hidden when it runs out, unless something holds them. */
  const arm = () => {
    disarm();
    if (!active) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (active && !held()) setHidden(true);
    }, ms);
  };

  const wake = () => {
    setHidden(false);
    arm();
  };

  // What held them is gone: the 2.5 s start from now.
  const setOverIsland = (value: boolean) => {
    const was = held();
    overIsland = value;
    if (was && !held()) arm();
  };
  const setFocusInIsland = (value: boolean) => {
    const was = held();
    focusInIsland = value;
    if (was && !held()) arm();
  };

  const abort = new AbortController();
  const listen = { signal: abort.signal, passive: true } as const;

  window.addEventListener(
    'pointermove',
    (e) => {
      setOverIsland(inIsland(e.target));
      // A move that goes nowhere (the browser repeating the last one) is none.
      if (e.clientX === x && e.clientY === y) return;
      x = e.clientX;
      y = e.clientY;
      wake();
    },
    listen,
  );
  // An island that comes up under a pointer that rests, or goes from under it.
  window.addEventListener('pointerover', (e) => setOverIsland(inIsland(e.target)), listen);
  document.documentElement.addEventListener(
    'pointerleave',
    (e) => {
      if (leftWindow(e.clientX, e.clientY)) setOverIsland(false);
    },
    listen,
  );
  // Capture: a control that stops the event does not keep the islands from showing.
  for (const type of ['pointerdown', 'wheel', 'keydown'] as const) {
    window.addEventListener(type, wake, { ...listen, capture: true });
  }
  window.addEventListener(
    'focusin',
    (e) => {
      const inside = inIsland(e.target);
      setFocusInIsland(inside);
      // Focus that comes to an island (a panel gives it back) shows the island.
      if (inside) wake();
    },
    listen,
  );
  window.addEventListener('focusout', (e) => setFocusInIsland(inIsland(e.relatedTarget)), listen);

  return {
    setActive(value) {
      if (active === value) return;
      active = value;
      if (value) wake();
      else {
        disarm();
        setHidden(false);
      }
    },
    destroy() {
      disarm();
      abort.abort();
    },
  };
}

/**
 * Whether the islands are hidden now, and hides the cursor with them. Call it once, where the
 * player is (`PlayerPage`).
 */
export function useAutohide(ms: number = AUTOHIDE_MS): boolean {
  const playing = usePlayerStore(selectPlaying);
  const panelOpen = useUiStore((state) => state.panel !== null);
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const mayHide = playing && !panelOpen && !sidebarOpen;
  const [timedOut, setTimedOut] = useState(false);
  const autohide = useRef<Autohide | null>(null);

  useEffect(() => {
    const controller = createAutohide({ ms, onChange: setTimedOut });
    autohide.current = controller;
    return () => {
      autohide.current = null;
      controller.destroy();
      // The next controller starts with the islands shown.
      setTimedOut(false);
    };
  }, [ms]);

  // After the effect above, which makes the controller (also when `ms` makes a new one).
  useEffect(() => {
    autohide.current?.setActive(mayHide);
  }, [mayHide, ms]);

  const hidden = mayHide && timedOut;

  // The cursor goes with the islands, and the shell's islands hear of it from the store.
  useEffect(() => {
    if (!hidden) return undefined;
    const root = document.documentElement;
    root.style.cursor = 'none';
    useUiStore.getState().setControlsHidden(true);
    return () => {
      root.style.cursor = '';
      useUiStore.getState().setControlsHidden(false);
    };
  }, [hidden]);

  return hidden;
}

/**
 * `active` kept `true` for `ms` after it turned `false`, so that something can fade out before it
 * is taken away.
 */
export function useLinger(active: boolean, ms: number): boolean {
  const [lingering, setLingering] = useState(active);
  useEffect(() => {
    if (active) {
      setLingering(true);
      return undefined;
    }
    const timer = setTimeout(() => {
      setLingering(false);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [active, ms]);
  return active || lingering;
}
