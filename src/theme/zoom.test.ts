import { afterEach, describe, expect, test, vi } from 'vitest';

import { NO_ZOOM, readZoomFrame, toOwnLength, toWindowBox, toWindowLength, zoomFrame } from './zoom';

/** A 1280 px wide window, and the root's width as each kind of engine reports it at `zoom`. */
const WINDOW = 1280;
const standardized = (zoom: number) => zoomFrame(zoom, WINDOW, WINDOW);
const legacy = (zoom: number) => zoomFrame(zoom, WINDOW / zoom, WINDOW);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the UI scale in CSS px of the window', () => {
  test('no zoom changes nothing', () => {
    expect(zoomFrame(1, WINDOW, WINDOW)).toEqual(NO_ZOOM);
    // A zoom that is no number (an engine without it) is none.
    expect(zoomFrame(Number.NaN, WINDOW, WINDOW)).toEqual(NO_ZOOM);
    expect(zoomFrame(0, WINDOW, WINDOW)).toEqual(NO_ZOOM);
    const box = { left: 10, top: 20, width: 300, height: 40 };
    expect(toWindowBox(box, NO_ZOOM)).toEqual(box);
    expect(toWindowLength(20, NO_ZOOM)).toBe(20);
  });

  test.each([0.9, 1.5])(
    'at %s rectangles are taken as they are where the engine reports window px (standardized zoom)',
    (zoom) => {
      const frame = standardized(zoom);
      expect(frame).toEqual({ zoom, rectsInWindowPx: true });
      expect(toWindowBox({ left: 24, top: 24, width: 300, height: 48 }, frame)).toEqual({
        left: 24,
        top: 24,
        width: 300,
        height: 48,
      });
    },
  );

  test.each([0.9, 1.5])('at %s rectangles in the element’s own px are scaled to window px', (zoom) => {
    const frame = legacy(zoom);
    expect(frame).toEqual({ zoom, rectsInWindowPx: false });
    const box = toWindowBox({ left: 16, top: 16, width: 200, height: 32 }, frame);
    expect(box.left).toBeCloseTo(16 * zoom);
    expect(box.top).toBeCloseTo(16 * zoom);
    expect(box.width).toBeCloseTo(200 * zoom);
    expect(box.height).toBeCloseTo(32 * zoom);
  });

  test.each([0.9, 1.5])('at %s a length of the element’s own CSS is zoomed with it', (zoom) => {
    // Both engines: getComputedStyle reports the length as written.
    expect(toWindowLength(20, standardized(zoom))).toBeCloseTo(20 * zoom);
    expect(toWindowLength(20, legacy(zoom))).toBeCloseTo(20 * zoom);
    // The element's own zoom wins where the engine reports it.
    expect(toWindowLength(20, standardized(zoom), 2)).toBe(40);
  });

  test.each([0.9, 1.5])('at %s a window length is set on an element in its own, zoomed px', (zoom) => {
    // Both engines: what an element's style says is zoomed on the screen.
    expect(toOwnLength(360 * zoom, standardized(zoom))).toBeCloseTo(360);
    expect(toOwnLength(360 * zoom, legacy(zoom))).toBeCloseTo(360);
    expect(toWindowLength(toOwnLength(203, standardized(zoom)), standardized(zoom))).toBeCloseTo(203);
    expect(toOwnLength(16, NO_ZOOM)).toBe(16);
  });

  test('a scrollbar or rounding does not change the reading', () => {
    // 17 px of scrollbar off the root at 150 %: still nearer the window's width than a third short.
    expect(zoomFrame(1.5, WINDOW - 17, WINDOW).rectsInWindowPx).toBe(true);
    expect(zoomFrame(1.5, WINDOW / 1.5 - 0.5, WINDOW).rectsInWindowPx).toBe(false);
    // Not laid out yet: the engine of today.
    expect(zoomFrame(1.5, 0, WINDOW)).toEqual({ zoom: 1.5, rectsInWindowPx: true });
  });

  test('the document is read without measuring it while nothing is zoomed', () => {
    const measured = vi.spyOn(document.documentElement, 'getBoundingClientRect');
    expect(readZoomFrame()).toEqual(NO_ZOOM);
    expect(measured).not.toHaveBeenCalled();
  });
});
