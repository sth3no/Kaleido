import { invoke } from '@tauri-apps/api/core';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ThumbReady } from '../ipc/types';
import ThumbBubble, { BUBBLE_MARGIN_PX, clampCenter, drawFrame } from './ThumbBubble';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
const events = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    events.handlers.set(name, handler);
    return Promise.resolve(() => undefined);
  }),
}));

describe('clampCenter', () => {
  test('keeps the middle of the bubble under the pointer when there is room', () => {
    expect(clampCenter(500, 100, 8, 1016)).toBe(500);
  });

  test('keeps the bubble inside the window at both ends', () => {
    // Its left edge stays at 8 px, its right edge at 1016 px.
    expect(clampCenter(10, 100, 8, 1016)).toBe(58);
    expect(clampCenter(1010, 100, 8, 1016)).toBe(966);
  });

  test('puts a bubble wider than the room in the middle of it', () => {
    expect(clampCenter(10, 400, 8, 208)).toBe(108);
  });

  test('the margin is a few px', () => {
    expect(BUBBLE_MARGIN_PX).toBeGreaterThan(0);
  });
});

describe('the picture', () => {
  /** A preview of 2 × 1 pixels as `thumb_get` hands it over: width, height, then RGBA. */
  const preview = (): ArrayBuffer => {
    const bytes = new ArrayBuffer(8 + 8);
    const view = new DataView(bytes);
    view.setUint32(0, 2, true);
    view.setUint32(4, 1, true);
    new Uint8Array(bytes, 8).set([255, 0, 0, 255, 0, 255, 0, 255]);
    return bytes;
  };

  const putImageData = vi.fn();
  const realGetContext = HTMLCanvasElement.prototype.getContext;
  /** Lets the answers that are on their way arrive. */
  const settle = async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  };

  beforeEach(() => {
    events.handlers.clear();
    putImageData.mockClear();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(((command: string) =>
      command === 'thumb_get' ? Promise.resolve(preview()) : Promise.resolve(null)) as unknown as typeof invoke);
    // jsdom has no canvas and no ImageData.
    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    vi.stubGlobal(
      'ImageData',
      class {
        constructor(
          readonly data: Uint8ClampedArray,
          readonly width: number,
          readonly height: number,
        ) {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = realGetContext;
    vi.unstubAllGlobals();
  });

  /** The event Rust sends when a new preview is stored. */
  const thumbReady = async (payload: ThumbReady = { width: 2, height: 1, seq: 1 }) => {
    await act(async () => {
      events.handlers.get('player:thumb')?.({ payload });
      // `thumb_get` answers on the next turns.
      await settle();
    });
  };

  const canvas = () => document.querySelector('canvas') as HTMLCanvasElement;

  test('drawFrame draws the pixels it is given and takes the size of the picture', () => {
    const element = document.createElement('canvas');
    const rgba = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(drawFrame(element, { width: 2, height: 1, rgba })).toBe(true);
    expect(element.width).toBe(2);
    expect(element.height).toBe(1);
    const [image] = putImageData.mock.calls[0] as [{ data: Uint8ClampedArray; width: number; height: number }];
    // The pixels are drawn where they are, not copied first.
    expect(image.data).toBe(rgba);
    expect([image.width, image.height]).toEqual([2, 1]);

    // No 2D context (a canvas that cannot draw): nothing is drawn, and it is said.
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    expect(drawFrame(element, { width: 2, height: 1, rgba })).toBe(false);
  });

  test('draws the preview when Rust says it is stored, and shows the time of the place', async () => {
    render(<ThumbBubble hover={{ fraction: 0.5, seconds: 125 }} />);
    expect(screen.getByText('2:05')).toBeTruthy();
    // Until the first preview comes there is only the time.
    expect(canvas().style.display).toBe('none');

    await thumbReady();
    expect(putImageData).toHaveBeenCalledTimes(1);
    expect(canvas().style.display).not.toBe('none');
    expect(canvas().style.width).toBe('2px');
    expect(canvas().style.height).toBe('1px');
  });

  test('a picture does not outlive the hover: the next one starts with the time alone', async () => {
    const { rerender } = render(<ThumbBubble hover={{ fraction: 0.5, seconds: 125 }} />);
    await thumbReady();
    expect(canvas().style.display).not.toBe('none');

    rerender(<ThumbBubble hover={null} />);
    expect(canvas().style.display).toBe('none');

    // A preview that comes when nobody is looking is not fetched, let alone drawn.
    const fetched = () => vi.mocked(invoke).mock.calls.filter(([name]) => name === 'thumb_get').length;
    const before = fetched();
    await thumbReady({ width: 2, height: 1, seq: 2 });
    expect(fetched()).toBe(before);
    expect(putImageData).toHaveBeenCalledTimes(1);
    expect(canvas().style.display).toBe('none');

    rerender(<ThumbBubble hover={{ fraction: 0.2, seconds: 40 }} />);
    expect(canvas().style.display).toBe('none');
  });

  test('of two previews in a row only the latest answer is drawn', async () => {
    const answers: ((bytes: ArrayBuffer) => void)[] = [];
    vi.mocked(invoke).mockImplementation(((command: string) =>
      command === 'thumb_get'
        ? new Promise<ArrayBuffer>((resolve) => {
            answers.push(resolve);
          })
        : Promise.resolve(null)) as unknown as typeof invoke);
    render(<ThumbBubble hover={{ fraction: 0.5, seconds: 125 }} />);

    await act(async () => {
      events.handlers.get('player:thumb')?.({ payload: { width: 2, height: 1, seq: 1 } });
      events.handlers.get('player:thumb')?.({ payload: { width: 2, height: 1, seq: 2 } });
      await settle();
    });
    expect(answers).toHaveLength(2);

    // The later request is answered first, the earlier one after it: the late answer is out of date.
    await act(async () => {
      answers[1]?.(preview());
      await settle();
    });
    expect(putImageData).toHaveBeenCalledTimes(1);
    await act(async () => {
      answers[0]?.(preview());
      await settle();
    });
    expect(putImageData).toHaveBeenCalledTimes(1);
  });

  test('the bubble is placed from the bar as it is measured through the UI scale', () => {
    // An engine that reports rectangles in the zoomed root's own px, at a UI scale of 200 %: the
    // root is half as wide as the 1024 px window, and every rectangle is half what it is in the window.
    const real = window.getComputedStyle.bind(window);
    const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) =>
      element === document.documentElement
        ? ({ getPropertyValue: (name: string) => (name === 'zoom' ? '2' : '') } as CSSStyleDeclaration)
        : real(element, pseudo),
    );
    const measured = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const own = (left: number, width: number) =>
          ({ left, top: 0, width, height: 20, right: left + width, bottom: 20, x: left, y: 0 }) as DOMRect;
        if (this === document.documentElement) return own(0, 512);
        // The bubble: 100 px wide. The bar it sits on: from 10 to 410.
        return this.hasAttribute('data-shown') ? own(0, 100) : own(10, 400);
      });

    try {
      render(<ThumbBubble hover={{ fraction: 0.01, seconds: 10 }} />);
      // In px of the window the bar is 20 to 820 and the bubble 200 wide: its middle may not go
      // below 8 + 100 = 108, which is (108 - 20) / 800 = 11 % along the bar. Unscaled it is 12 %.
      const bubble = document.querySelector('[data-shown]') as HTMLElement;
      expect(Number.parseFloat(bubble.style.left)).toBeCloseTo(11, 6);
    } finally {
      measured.mockRestore();
      styles.mockRestore();
    }
  });

  test('the bubble is shown while the pointer is on the bar', () => {
    const { rerender } = render(<ThumbBubble hover={null} />);
    const bubble = document.querySelector('[data-shown]');
    expect(bubble?.getAttribute('data-shown')).toBe('false');
    rerender(<ThumbBubble hover={{ fraction: 0.5, seconds: 10 }} />);
    expect(bubble?.getAttribute('data-shown')).toBe('true');
  });
});
