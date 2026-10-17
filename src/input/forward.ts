import { playerInput } from '../ipc/commands';
import type { InputEvent } from '../ipc/types';
import { toMpvKey } from './keys';
import { buttonName, toSurfacePoint, type Point } from './mouse';
import { createKeyTracker } from './tracker';
import { WheelAccumulator } from './wheel';

/** What `player_input` takes (src-tauri/src/input.rs); the type is in the IPC contract. */
export type { InputEvent };

const send = (event: InputEvent) => {
  playerInput(event).catch((error: unknown) => {
    console.warn('player_input', error);
  });
};

const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const EDITABLE = '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/** Whether typing in `target` is for the control itself: a text field, a list, an editor. */
function ownsTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return TEXT_TAGS.has(target.tagName) || target.isContentEditable || target.closest(EDITABLE) !== null;
}

/** Keys that belong to Windows: closing and switching windows, the window menu, the Win key. */
function isSystemShortcut(e: KeyboardEvent): boolean {
  if (e.metaKey) return true;
  return e.altKey && (e.key === 'F4' || e.key === 'Tab' || e.key === ' ' || e.code === 'Space');
}

/** Tab and Shift+Tab move the focus through the UI (spec 8.9); mpv never gets them. */
function isFocusMove(e: KeyboardEvent): boolean {
  return e.key === 'Tab' && !e.ctrlKey;
}

/** What the browser activates with Enter or Space. */
const ACTIVATABLE = [
  'button',
  'a[href]',
  'summary',
  ...['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option'].map(
    (role) => `[role="${role}"]`,
  ),
].join(', ');

/** Enter or Space on a focused control that they activate: the control gets them, not mpv. */
function activatesControl(e: KeyboardEvent): boolean {
  return (
    (e.key === 'Enter' || e.key === ' ') &&
    e.target instanceof HTMLElement &&
    e.target.matches(ACTIVATABLE)
  );
}

/**
 * Whether the key goes on to mpv. Not when it is typing in a text field, composes text (an IME),
 * is a Windows shortcut, moves the focus (Tab), activates the focused button or link (Enter,
 * Space), or was already handled by a control of the UI, which says so with `preventDefault`
 * (the seek bar, a panel). Other keys on a focused control, the arrows say, go to mpv unless the
 * control handles them. The listener runs in the bubbling phase, after the controls.
 */
export function shouldForward(e: KeyboardEvent): boolean {
  return !(
    e.defaultPrevented ||
    e.isComposing ||
    isSystemShortcut(e) ||
    isFocusMove(e) ||
    activatesControl(e) ||
    ownsTyping(e.target)
  );
}

/**
 * Sends mpv what the UI does not handle: the mouse, its buttons and the wheel over `el` (the
 * layer that covers the video), and the keyboard of the whole window. Returns the function that
 * stops it; it also lets go of whatever is still held.
 */
export function attachVideoInput(el: HTMLElement): () => void {
  const abort = new AbortController();
  const { signal } = abort;
  const keys = createKeyTracker();
  const wheel = new WheelAccumulator();
  const buttons = new Set<string>();
  let pending: Point | null = null;
  let frame: number | null = null;

  const point = (e: { clientX: number; clientY: number }) =>
    toSurfacePoint(e.clientX, e.clientY, el.getBoundingClientRect(), window.devicePixelRatio);

  // Moves are sent at most once per frame, and before anything that depends on where the
  // pointer is, so that mpv sees them in the order they happened.
  const flushMove = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (pending) send({ type: 'mouseMove', ...pending });
    pending = null;
  };

  const releaseButtons = () => {
    flushMove();
    for (const button of buttons) send({ type: 'buttonUp', button });
    buttons.clear();
  };

  const releaseAll = () => {
    for (const key of keys.releaseAll()) send({ type: 'keyUp', key });
    releaseButtons();
  };

  // Keyboard: the whole window, in the bubbling phase.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!shouldForward(e)) return;
      const key = toMpvKey({
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        altGraph: e.getModifierState('AltGraph'),
      });
      if (!key) return;
      e.preventDefault();
      // Auto-repeat is mpv's job: it repeats a held keydown until keyup.
      if (keys.down(e.code || e.key, key)) send({ type: 'keyDown', key });
    },
    { signal },
  );
  // A release is always passed on for a key that was pressed, wherever the focus is by then.
  window.addEventListener(
    'keyup',
    (e) => {
      const key = keys.up(e.code || e.key);
      if (!key) return;
      e.preventDefault();
      send({ type: 'keyUp', key });
    },
    { signal },
  );
  window.addEventListener('blur', releaseAll, { signal });

  // Mouse: the video layer.
  el.addEventListener(
    'pointermove',
    (e) => {
      const p = point(e);
      if (!p) return;
      pending = p;
      frame ??= requestAnimationFrame(() => {
        frame = null;
        flushMove();
      });
    },
    { signal },
  );
  el.addEventListener(
    'pointerdown',
    (e) => {
      const button = buttonName(e.button);
      const p = point(e);
      if (!button || !p) return;
      // The release comes to the layer even if the pointer has left it.
      el.setPointerCapture(e.pointerId);
      pending = p;
      flushMove();
      buttons.add(button);
      send({ type: 'buttonDown', button });
    },
    { signal },
  );
  el.addEventListener(
    'pointerup',
    (e) => {
      const button = buttonName(e.button);
      // Only a press this layer sent: not the end of a drag that began on the controls.
      if (!button || !buttons.delete(button)) return;
      flushMove();
      send({ type: 'buttonUp', button });
    },
    { signal },
  );
  // The system took the pointer away (a touch turned into a pan): no release will come.
  el.addEventListener('pointercancel', releaseButtons, { signal });
  el.addEventListener(
    'wheel',
    (e) => {
      // Not passive: a wheel over the video neither scrolls nor zooms the page (Ctrl + wheel).
      e.preventDefault();
      const step = wheel.push(e);
      if (!step) return;
      flushMove();
      send({ type: 'wheel', ...step });
    },
    { signal, passive: false },
  );
  // Right button: mpv's menu, not the WebView's.
  el.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
  // The side buttons go to mpv as MBTN_BACK and MBTN_FORWARD (above); the WebView must not also
  // take them as history navigation, which would leave the app.
  const keepInApp = (e: MouseEvent) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  };
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick'] as const) {
    el.addEventListener(type, keepInApp, { signal });
  }

  return () => {
    releaseAll();
    abort.abort();
  };
}
