import { invoke } from '@tauri-apps/api/core';
import type { MouseEvent, PointerEvent, WheelEvent } from 'react';
import { toMpvKey } from './keys';
import { buttonName, toSurfacePoint, wheelKey, type SurfaceRect } from './mouse';
import { createKeyTracker } from './tracker';

export type InputEvent =
  | { type: 'keyDown'; key: string }
  | { type: 'keyUp'; key: string }
  | { type: 'mouseMove'; x: number; y: number }
  | { type: 'buttonDown'; button: string }
  | { type: 'buttonUp'; button: string }
  | { type: 'wheel'; key: string }
  | { type: 'doubleClick' };

/** Flip to true if mpv does not synthesize MBTN_LEFT_DBL from keydown/keyup (report row 3). */
export const SEND_EXPLICIT_DOUBLE_CLICK = false;

const send = (ev: InputEvent) => {
  invoke('player_input', { ev }).catch((e) => console.warn('player_input', e));
};

const INTERACTIVE = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT']);
const ownsKeyboard = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || INTERACTIVE.has(t.tagName));

/** Keys go to mpv unless a UI handler called preventDefault or focus is in a UI control. */
export function installKeyboardForwarding(): () => void {
  const tracker = createKeyTracker();
  const onDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || ownsKeyboard(e.target)) return;
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
    if (tracker.down(e.code || e.key, key)) send({ type: 'keyDown', key });
  };
  const onUp = (e: KeyboardEvent) => {
    const key = tracker.up(e.code || e.key);
    if (!key) return;
    e.preventDefault();
    send({ type: 'keyUp', key });
  };
  const onBlur = () => tracker.releaseAll().forEach((key) => send({ type: 'keyUp', key }));
  window.addEventListener('keydown', onDown);
  window.addEventListener('keyup', onUp);
  window.addEventListener('blur', onBlur);
  return () => {
    onBlur();
    window.removeEventListener('keydown', onDown);
    window.removeEventListener('keyup', onUp);
    window.removeEventListener('blur', onBlur);
  };
}

/** Pointer handlers for the layer that covers the video under the controls. */
export function videoPointerHandlers(getSurface: () => SurfaceRect) {
  let pending: { x: number; y: number } | null = null;
  let scheduled = false;
  const point = (e: { clientX: number; clientY: number }) =>
    toSurfacePoint(e.clientX, e.clientY, getSurface(), window.devicePixelRatio);
  return {
    onPointerMove(e: PointerEvent) {
      pending = point(e);
      if (!pending || scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (pending) send({ type: 'mouseMove', ...pending });
      });
    },
    onPointerDown(e: PointerEvent) {
      const p = point(e);
      const button = buttonName(e.button);
      if (!p || !button) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      send({ type: 'mouseMove', ...p });
      send({ type: 'buttonDown', button });
      if (SEND_EXPLICIT_DOUBLE_CLICK && e.detail === 2 && button === 'MBTN_LEFT') send({ type: 'doubleClick' });
    },
    onPointerUp(e: PointerEvent) {
      const button = buttonName(e.button);
      if (button) send({ type: 'buttonUp', button });
    },
    onWheel(e: WheelEvent) {
      const key = wheelKey(e.deltaX, e.deltaY);
      if (key) send({ type: 'wheel', key });
    },
    onContextMenu(e: MouseEvent) {
      e.preventDefault();
    },
  };
}

/** UI buttons and sliders give keyboard focus back after a click, so Space/arrows reach mpv. */
export const blurAfterPointer = {
  onPointerUp: (e: PointerEvent<HTMLElement>) => e.currentTarget.blur(),
};
