import { invoke } from '@tauri-apps/api/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeAll, beforeEach, expect, test, vi, type MockInstance } from 'vitest';

import type { GlassRect } from '../ipc/types';
import { attachVideoInput, blurAfterPointer } from '../input/forward';
import { useUiStore } from '../state/uiStore';
import Popover, { tabbablesOf } from './Popover';
import { realClick } from './pointerSequence';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

/** The animation frames asked for and not run yet (the glass measures on them). */
let frames: FrameRequestCallback[] = [];
let measured: MockInstance<() => DOMRect>;

/** Runs the frames the browser would run next. */
function runFrame(): void {
  const due = frames;
  frames = [];
  for (const callback of due) callback(performance.now());
}

/** The panel is 330 × 200, its button 34 × 34 at (500, 650); the window (jsdom's) is 1024 × 768. */
const PANEL_BOX = { left: 0, top: 0, width: 330, height: 200 };
const BUTTON_BOX = { left: 500, top: 650, width: 34, height: 34 };
const NO_BOX = { left: 0, top: 0, width: 0, height: 0 };
/** The video layer covers the window. */
const VIDEO_BOX = { left: 0, top: 0, width: 1024, height: 768 };

const asRect = (box: { left: number; top: number; width: number; height: number }) =>
  ({
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
  }) as DOMRect;

beforeAll(() => {
  // jsdom has no pointer capture; the video layer takes it when it gets a press.
  Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
});

beforeEach(() => {
  frames = [];
  vi.mocked(invoke).mockClear();
  useUiStore.setState(useUiStore.getInitialState(), true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.getAttribute('role') === 'dialog') return asRect(PANEL_BOX);
    if (this.hasAttribute('data-video-layer')) return asRect(VIDEO_BOX);
    return asRect(this.hasAttribute('data-anchor') ? BUTTON_BOX : NO_BOX);
  });
});

afterEach(() => {
  // Unmounted while the frames are still ours, and the last frame run: the shared glass list is
  // empty again and waits for nothing when the next test starts.
  cleanup();
  runFrame();
  measured.mockRestore();
  vi.unstubAllGlobals();
});

/**
 * A button that opens a panel with three buttons, a slider and a button that closes it, a video layer
 * and a button beside it. The buttons give the focus back after a pointer as the island's do.
 */
function Harness({ onClose, marked = true }: { onClose?: () => void; marked?: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-anchor
        onClick={() => {
          setOpen((was) => !was);
        }}
        {...blurAfterPointer}
      >
        Open
      </button>
      {open && (
        <Popover
          anchor={anchor}
          label="Test panel"
          onClose={() => {
            setOpen(false);
            onClose?.();
          }}
        >
          <button type="button">One</button>
          <button type="button" data-autofocus={marked ? '' : undefined}>
            Two
          </button>
          <button type="button">Three</button>
          <input type="range" aria-label="Slider" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
            }}
          >
            Done
          </button>
        </Popover>
      )}
      <div data-video-layer data-testid="video" />
      <button type="button" {...blurAfterPointer}>
        Elsewhere
      </button>
    </>
  );
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

/** Renders the harness and opens the panel with a click of the mouse on its button. */
function open(props: Parameters<typeof Harness>[0] = {}) {
  const view = render(<Harness {...props} />);
  realClick(button('Open'));
  return { ...view, dialog: screen.getByRole('dialog', { name: 'Test panel' }) };
}

/** What was passed on to mpv. */
const forwarded = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'player_input');

/** The events of one kind (`keyDown`, `buttonDown`, ...) that were passed on to mpv. */
const sentToMpv = (type: string): { type: string; key?: string; button?: string }[] =>
  forwarded()
    .map(([, args]) => (args as { event: { type: string; key?: string; button?: string } }).event)
    .filter((event) => event.type === type);

test('the panel is a dialog with the focus in it, on the element that asks for it', () => {
  const { dialog } = open();
  expect(dialog.hasAttribute('data-island')).toBe(true);
  // A dialog that keeps the focus in it says so.
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(document.activeElement).toBe(button('Two'));
});

test('without an element that asks for the focus it goes to the first one Tab reaches', () => {
  open({ marked: false });
  expect(document.activeElement).toBe(button('One'));
});

test('tabbablesOf lists what Tab reaches, in order', () => {
  const { dialog } = open();
  // A button taken out of the order by a roving tabindex, a disabled one and one in an inert part.
  dialog.insertAdjacentHTML(
    'beforeend',
    '<button tabindex="-1">Skipped</button><button disabled>Off</button><div inert><button>Inert</button></div>',
  );
  expect(tabbablesOf(dialog).map((element) => element.getAttribute('aria-label') ?? element.textContent)).toEqual([
    'One',
    'Two',
    'Three',
    'Slider',
    'Done',
  ]);
});

test('the panel stands over its button, in the middle of it, inside the window', () => {
  const { dialog } = open();
  // The button's middle is at 517: a panel 330 wide starts at 352. It ends 8 px above the button.
  expect(dialog.style.left).toBe('352px');
  expect(dialog.style.top).toBe(`${650 - 8 - 200}px`);
});

test('the panel is placed from the button as it is measured through the UI scale', () => {
  // An engine that reports rectangles in the zoomed root's own px, at a UI scale of 200 %: the
  // root is half as wide as the 1024 px window, and every rectangle is half what it is in the window.
  const real = window.getComputedStyle.bind(window);
  const styles = vi
    .spyOn(window, 'getComputedStyle')
    .mockImplementation((element: Element, pseudo?: string | null) =>
      element === document.documentElement
        ? ({ getPropertyValue: (name: string) => (name === 'zoom' ? '2' : '') } as CSSStyleDeclaration)
        : real(element, pseudo),
    );
  measured.mockImplementation(function (this: HTMLElement) {
    if (this === document.documentElement) return asRect({ left: 0, top: 0, width: 512, height: 384 });
    if (this.getAttribute('role') === 'dialog') return asRect({ left: 0, top: 0, width: 165, height: 100 });
    return asRect(
      this.hasAttribute('data-anchor') ? { left: 250, top: 300, width: 17, height: 17 } : NO_BOX,
    );
  });
  try {
    const { dialog } = open();
    // In px of the window: the button at (500, 600) is 34 wide, the panel 330 × 200, so the panel
    // is at x 352, y 392; `left` and `top` are in the panel's own px, which are two window px.
    expect(dialog.style.left).toBe('176px');
    expect(dialog.style.top).toBe('196px');
    // And it may take what is left of the window, in its own px as well.
    expect(dialog.style.getPropertyValue('--popover-fit-w')).toBe(`${(1024 - 16) / 2}px`);
    expect(dialog.style.getPropertyValue('--popover-fit-h')).toBe(`${(768 - 16) / 2}px`);
  } finally {
    styles.mockRestore();
  }
});

test('escape closes the panel and returns focus to its button, and mpv does not get it', () => {
  const detach = attachVideoInput(document.createElement('div'));
  try {
    const onClose = vi.fn();
    open({ onClose });
    const opener = button('Open');
    expect(document.activeElement).not.toBe(opener);

    const passedOn = fireEvent.keyDown(document.activeElement as Element, {
      key: 'Escape',
      code: 'Escape',
    });

    // Handled: mpv does not get Esc (it would leave fullscreen).
    expect(passedOn).toBe(false);
    expect(forwarded()).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);

    // Not vacuous: with no panel open the same key does go on to mpv.
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    expect(forwarded()).toHaveLength(1);
  } finally {
    detach();
  }
});

test('a key the panel has already handled is left alone by it', () => {
  const onClose = vi.fn();
  open({ onClose });
  const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
  document.body.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
  document.body.dispatchEvent(handled);
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).not.toBeNull();
});

test('a click on the button closes the panel and leaves nothing focused, so Space goes to mpv', () => {
  open();
  const detach = attachVideoInput(screen.getByTestId('video'));
  try {
    // pointerdown, mousedown and the focus it moves, pointerup, click: as the browser delivers it.
    realClick(button('Open'));

    expect(screen.queryByRole('dialog')).toBeNull();
    // Not the button: a button that held the focus would keep Space from mpv and press itself.
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: ' ', code: 'Space' });
    expect(sentToMpv('keyDown').map((event) => event.key)).toEqual(['SPACE']);
  } finally {
    detach();
  }
});

test('a press outside on a control closes the panel and leaves nothing focused, so Space goes to mpv', () => {
  open();
  const detach = attachVideoInput(screen.getByTestId('video'));
  try {
    realClick(button('Elsewhere'));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
    expect(sentToMpv('keyDown').map((event) => event.key)).toEqual(['SPACE']);
  } finally {
    detach();
  }
});

test('a press on the bare video closes the panel, mpv gets no mouse button from it, and Space goes to mpv', () => {
  const onClose = vi.fn();
  open({ onClose });
  const video = screen.getByTestId('video');
  const detach = attachVideoInput(video);
  try {
    realClick(video);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    // The press (and its release) did not reach the video layer's input: no button pair for mpv.
    expect(sentToMpv('buttonDown')).toEqual([]);
    expect(sentToMpv('buttonUp')).toEqual([]);
    expect(sentToMpv('mouseMove')).toEqual([]);

    // Nothing is focused, so Space pauses.
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
    expect(sentToMpv('keyDown').map((event) => event.key)).toEqual(['SPACE']);

    // Not vacuous: with the panel gone, the same click does reach mpv, as a pair.
    realClick(video);
    expect(sentToMpv('buttonDown').map((event) => event.button)).toEqual(['MBTN_LEFT']);
    expect(sentToMpv('buttonUp').map((event) => event.button)).toEqual(['MBTN_LEFT']);
  } finally {
    detach();
  }
});

test('an item that closes the panel returns the focus to the button after the keyboard, and not after the mouse', () => {
  open();
  const done = button('Done');
  act(() => {
    done.focus();
  });
  // Enter: a key, then the click it makes (a click with no click count).
  fireEvent.keyDown(done, { key: 'Enter', code: 'Enter' });
  fireEvent.click(done, { detail: 0 });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(button('Open'));

  // The same item with the mouse: nothing is focused.
  realClick(button('Open'));
  expect(screen.queryByRole('dialog')).not.toBeNull();
  realClick(button('Done'));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(document.body);
});

test('tab goes round inside the panel, and shift+tab the other way', () => {
  const { dialog } = open();
  const one = button('One');
  const two = button('Two');
  const slider = screen.getByRole('slider', { name: 'Slider' });

  // From the last element to the first, and back.
  slider.focus();
  expect(fireEvent.keyDown(slider, { key: 'Tab', code: 'Tab' })).toBe(false);
  expect(document.activeElement).toBe(one);
  expect(fireEvent.keyDown(one, { key: 'Tab', code: 'Tab', shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(slider);

  // In the middle the browser moves the focus itself.
  two.focus();
  expect(fireEvent.keyDown(two, { key: 'Tab', code: 'Tab' })).toBe(true);
  expect(document.activeElement).toBe(two);

  // From the panel's own background (nothing in it focused) Tab goes to the end it was heading for.
  dialog.focus();
  expect(fireEvent.keyDown(dialog, { key: 'Tab', code: 'Tab' })).toBe(false);
  expect(document.activeElement).toBe(one);
  dialog.focus();
  expect(fireEvent.keyDown(dialog, { key: 'Tab', code: 'Tab', shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(slider);
});

test('focus that lands outside the panel is brought back in', () => {
  const { dialog } = open();
  button('Elsewhere').focus();
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).not.toBe(button('Elsewhere'));
});

test('a press outside closes the panel, on its button or inside it it does not', () => {
  const onClose = vi.fn();
  open({ onClose });

  // The button's click is what closes (or switches) the panel; the press itself does nothing.
  fireEvent.pointerDown(button('Open'), { button: 0, pointerId: 1 });
  fireEvent.pointerDown(button('One'), { button: 0, pointerId: 1 });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).not.toBeNull();

  // Another control: the panel closes and the press goes on to the control.
  const reaches = fireEvent.pointerDown(button('Elsewhere'), { button: 0, pointerId: 1 });
  expect(reaches).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('the arrows and the page keys are the panel’s while the focus is in it; a slider keeps its own', () => {
  const detach = attachVideoInput(document.createElement('div'));
  try {
    open();
    const two = button('Two');
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) {
      // Handled (here: swallowed): mpv would seek or change the volume behind the panel.
      expect(fireEvent.keyDown(two, { key, code: key }), key).toBe(false);
    }
    expect(forwarded()).toEqual([]);

    // The slider moves with them itself.
    const slider = screen.getByRole('slider', { name: 'Slider' });
    expect(fireEvent.keyDown(slider, { key: 'ArrowLeft', code: 'ArrowLeft' })).toBe(true);
    // Other keys are not the panel's business.
    expect(fireEvent.keyDown(two, { key: 'x', code: 'KeyX' })).toBe(true);
  } finally {
    detach();
  }
});

test('the panel is one of the glass regions the shader blurs', () => {
  open();
  runFrame();
  const sent = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === 'glass_set_regions')
    .map(([, args]) => (args as { rects: GlassRect[] }).rects);
  expect(sent.at(-1)).toEqual([expect.objectContaining({ w: 330, h: 200 })]);
});
