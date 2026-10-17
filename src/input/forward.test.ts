import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { attachVideoInput, shouldForward, type InputEvent } from './forward';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

/** Dispatches a keyboard event on `target` the way the browser does (bubbling, cancelable). */
function key(
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit,
  target: EventTarget = document.body,
): KeyboardEvent {
  const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('shouldForward', () => {
  test('system shortcuts are not forwarded', () => {
    expect(shouldForward(key('keydown', { key: 'F4', code: 'F4', altKey: true }))).toBe(false);
    expect(shouldForward(key('keydown', { key: ' ', code: 'Space', altKey: true }))).toBe(false);
    expect(shouldForward(key('keydown', { key: 'Tab', code: 'Tab', altKey: true }))).toBe(false);
    // The Win key: Win+E, Win+D, ...
    expect(shouldForward(key('keydown', { key: 'e', code: 'KeyE', metaKey: true }))).toBe(false);
    // Without Alt or Win the same keys are for mpv.
    expect(shouldForward(key('keydown', { key: 'F4', code: 'F4' }))).toBe(true);
    expect(shouldForward(key('keydown', { key: ' ', code: 'Space' }))).toBe(true);
  });

  test('typing in text fields is not forwarded', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inside = document.createElement('span');
    editable.append(inside);
    const targets = [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
      editable,
      inside,
    ];
    document.body.append(...targets.filter((target) => target !== inside));
    for (const target of targets) {
      expect(shouldForward(key('keydown', { key: 'a', code: 'KeyA' }, target))).toBe(false);
    }
  });

  test('keys a focused control handled are not forwarded', () => {
    const control = document.createElement('div');
    control.addEventListener('keydown', (e) => e.preventDefault());
    document.body.append(control);
    expect(shouldForward(key('keydown', { key: 'ArrowRight', code: 'ArrowRight' }, control))).toBe(
      false,
    );
    // The same key in a control that did not handle it is for mpv.
    expect(shouldForward(key('keydown', { key: 'ArrowRight', code: 'ArrowRight' }))).toBe(true);
  });

  test('keys that compose text (an input method) are not forwarded', () => {
    expect(shouldForward(key('keydown', { key: 'Process', isComposing: true }))).toBe(false);
    expect(shouldForward(key('keydown', { key: 'a', code: 'KeyA', isComposing: true }))).toBe(false);
  });

  test('other keys are forwarded, also with a button or the page in focus', () => {
    const button = document.createElement('button');
    document.body.append(button);
    for (const target of [document.body, button]) {
      expect(shouldForward(key('keydown', { key: 'a', code: 'KeyA' }, target))).toBe(true);
      expect(shouldForward(key('keydown', { key: 'a', code: 'KeyA', ctrlKey: true }, target))).toBe(
        true,
      );
      expect(shouldForward(key('keydown', { key: 'ArrowLeft', shiftKey: true }, target))).toBe(true);
    }
  });
});

describe('attachVideoInput', () => {
  let el: HTMLElement;
  let detach: () => void;
  let nextFrame: number;
  const frames = new Map<number, FrameRequestCallback>();

  /** What was sent to Rust so far, in order. */
  const sent = (): InputEvent[] =>
    vi.mocked(invoke).mock.calls.map(([command, args]) => {
      expect(command).toBe('player_input');
      return (args as { event: InputEvent }).event;
    });

  /** Lets the next animation frame come. */
  const frame = () => {
    const due = [...frames.values()];
    frames.clear();
    for (const run of due) run(0);
  };

  /** A pointer event over the layer. Without options: the pointer at (110, 70). */
  const pointer = (type: string, init: PointerEventInit = {}) => {
    const e = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      clientX: 110,
      clientY: 70,
      ...init,
    });
    el.dispatchEvent(e);
    return e;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    frames.clear();
    nextFrame = 1;
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
      frames.set(nextFrame, run);
      return nextFrame++;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id);
    });
    Object.defineProperty(window, 'devicePixelRatio', { value: 1.5, configurable: true });
    el = document.createElement('div');
    document.body.append(el);
    // The layer's rectangle: 400 × 300 CSS px, its corner at (10, 20).
    el.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 300 }) as DOMRect;
    el.setPointerCapture = vi.fn();
    detach = attachVideoInput(el);
  });

  afterEach(() => {
    detach();
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
  });

  test('a key press and its release go on in order, and a held key is not sent again', () => {
    const down = key('keydown', { key: 'ArrowRight', code: 'ArrowRight' });
    key('keydown', { key: 'ArrowRight', code: 'ArrowRight', repeat: true });
    const up = key('keyup', { key: 'ArrowRight', code: 'ArrowRight' });
    expect(sent()).toEqual([
      { type: 'keyDown', key: 'RIGHT' },
      { type: 'keyUp', key: 'RIGHT' },
    ]);
    expect(down.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
  });

  test('a key is released under the name it was pressed with, even if Ctrl went up first', () => {
    key('keydown', { key: 'a', code: 'KeyA', ctrlKey: true });
    key('keyup', { key: 'a', code: 'KeyA' });
    expect(sent()).toEqual([
      { type: 'keyDown', key: 'Ctrl+a' },
      { type: 'keyUp', key: 'Ctrl+a' },
    ]);
  });

  test('Czech letters, AltGr characters and the numpad keep the names mpv knows them by', () => {
    key('keydown', { key: 'ě', code: 'Digit2' });
    key('keydown', { key: '€', code: 'KeyE', ctrlKey: true, altKey: true, modifierAltGraph: true });
    key('keydown', { key: '+', code: 'NumpadAdd' });
    expect(sent()).toEqual([
      { type: 'keyDown', key: 'ě' },
      { type: 'keyDown', key: '€' },
      { type: 'keyDown', key: 'KP_ADD' },
    ]);
  });

  test('typing in a text field and keys a control handled stay in the UI', () => {
    const field = document.createElement('input');
    const control = document.createElement('div');
    control.addEventListener('keydown', (e) => e.preventDefault());
    document.body.append(field, control);
    const typed = key('keydown', { key: 'a', code: 'KeyA' }, field);
    key('keydown', { key: 'ArrowRight', code: 'ArrowRight' }, control);
    expect(sent()).toEqual([]);
    expect(typed.defaultPrevented).toBe(false);
  });

  test('Alt+F4 and Alt+Tab are left to Windows', () => {
    const close = key('keydown', { key: 'F4', code: 'F4', altKey: true });
    const swap = key('keydown', { key: 'Tab', code: 'Tab', altKey: true });
    expect(sent()).toEqual([]);
    expect(close.defaultPrevented).toBe(false);
    expect(swap.defaultPrevented).toBe(false);
  });

  test('a key pressed over the page is released even if the focus has moved into a field', () => {
    key('keydown', { key: 'ArrowRight', code: 'ArrowRight' });
    const field = document.createElement('input');
    document.body.append(field);
    key('keyup', { key: 'ArrowRight', code: 'ArrowRight' }, field);
    expect(sent()).toEqual([
      { type: 'keyDown', key: 'RIGHT' },
      { type: 'keyUp', key: 'RIGHT' },
    ]);
  });

  test('held keys and buttons are released when the window loses focus', () => {
    key('keydown', { key: 'a', code: 'KeyA' });
    pointer('pointerdown', { button: 0 });
    window.dispatchEvent(new Event('blur'));
    expect(sent()).toEqual([
      { type: 'keyDown', key: 'a' },
      { type: 'mouseMove', x: 150, y: 75 },
      { type: 'buttonDown', button: 'MBTN_LEFT' },
      { type: 'keyUp', key: 'a' },
      { type: 'buttonUp', button: 'MBTN_LEFT' },
    ]);
    // Released once: the real release that may follow finds nothing held.
    key('keyup', { key: 'a', code: 'KeyA' });
    pointer('pointerup', { button: 0 });
    expect(sent()).toHaveLength(5);
  });

  test('the pointer goes to mpv in window pixels, once per frame', () => {
    pointer('pointermove', { clientX: 110, clientY: 70 });
    pointer('pointermove', { clientX: 210, clientY: 120 });
    expect(sent()).toEqual([]);
    frame();
    // (210 - 10) × 1.5 and (120 - 20) × 1.5
    expect(sent()).toEqual([{ type: 'mouseMove', x: 300, y: 150 }]);
    frame();
    expect(sent()).toHaveLength(1);
  });

  test('the pointer outside the layer is not sent', () => {
    pointer('pointermove', { clientX: 5, clientY: 70 });
    pointer('pointermove', { clientX: 410, clientY: 70 });
    frame();
    expect(sent()).toEqual([]);
  });

  test('a button goes down at the pointer and up again', () => {
    pointer('pointerdown', { button: 0 });
    expect(el.setPointerCapture).toHaveBeenCalledWith(1);
    pointer('pointerup', { button: 0 });
    pointer('pointerdown', { button: 2 });
    pointer('pointerup', { button: 2 });
    expect(sent()).toEqual([
      { type: 'mouseMove', x: 150, y: 75 },
      { type: 'buttonDown', button: 'MBTN_LEFT' },
      { type: 'buttonUp', button: 'MBTN_LEFT' },
      { type: 'mouseMove', x: 150, y: 75 },
      { type: 'buttonDown', button: 'MBTN_RIGHT' },
      { type: 'buttonUp', button: 'MBTN_RIGHT' },
    ]);
  });

  test('a move that waits for its frame is sent before the button that follows it', () => {
    pointer('pointerdown', { button: 0 });
    pointer('pointermove', { clientX: 210, clientY: 120 });
    pointer('pointerup', { button: 0, clientX: 210, clientY: 120 });
    expect(sent().slice(2)).toEqual([
      { type: 'mouseMove', x: 300, y: 150 },
      { type: 'buttonUp', button: 'MBTN_LEFT' },
    ]);
    // The frame that was waiting has nothing left to send.
    frame();
    expect(sent()).toHaveLength(4);
  });

  test('a press outside the layer, with an unknown button, or a release never seen is ignored', () => {
    pointer('pointerdown', { button: 0, clientX: 5 });
    pointer('pointerdown', { button: 7 });
    pointer('pointerup', { button: 0 });
    expect(sent()).toEqual([]);
    expect(el.setPointerCapture).not.toHaveBeenCalled();
  });

  test('a cancelled pointer releases the buttons it held', () => {
    pointer('pointerdown', { button: 2 });
    pointer('pointercancel', { button: 0 });
    expect(sent().slice(2)).toEqual([{ type: 'buttonUp', button: 'MBTN_RIGHT' }]);
  });

  /** The wheel turned by `deltaY` pixels over the layer. */
  const wheel = (deltaY: number) => {
    const e = new WheelEvent('wheel', { deltaY, deltaMode: 0, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
  };

  test('the wheel goes to mpv in whole notches and does not scroll the page', () => {
    const notch = wheel(-100);
    const bits = [wheel(30), wheel(30)];
    expect(sent()).toEqual([{ type: 'wheel', key: 'WHEEL_UP', steps: 1 }]);
    for (const e of [notch, ...bits]) expect(e.defaultPrevented).toBe(true);
  });

  test('the wheel turns after the pointer move that came before it', () => {
    pointer('pointermove', { clientX: 210, clientY: 120 });
    wheel(100);
    expect(sent()).toEqual([
      { type: 'mouseMove', x: 300, y: 150 },
      { type: 'wheel', key: 'WHEEL_DOWN', steps: 1 },
    ]);
  });

  test('the right button does not open the WebView context menu', () => {
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
  });

  test('detaching releases what is held and stops forwarding', () => {
    key('keydown', { key: 'a', code: 'KeyA' });
    pointer('pointerdown', { button: 0 });
    detach();
    expect(sent().slice(3)).toEqual([
      { type: 'keyUp', key: 'a' },
      { type: 'buttonUp', button: 'MBTN_LEFT' },
    ]);
    const count = sent().length;
    key('keydown', { key: 'b', code: 'KeyB' });
    pointer('pointerdown', { button: 0 });
    wheel(100);
    expect(sent()).toHaveLength(count);
  });
});
