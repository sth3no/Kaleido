import { describe, expect, test } from 'vitest';

import { ANCHOR_GAP_PX, PANEL_MARGIN_PX, placeAbove } from './placement';

/** A button as `getBoundingClientRect` gives it: where, and how big. */
const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
});

const WINDOW = { w: 1280, h: 720 };
const PANEL = { w: 320, h: 400 };

describe('placeAbove', () => {
  test('popover stays inside the window', () => {
    expect(placeAbove(rect(1250, 680, 30, 30), PANEL, WINDOW).x).toBeLessThanOrEqual(1280 - 320);
  });

  test('is centred over the button and stands above it with a gap', () => {
    // The button's middle is at 640: a panel 320 wide starts at 480. It ends `gap` above the button.
    expect(placeAbove(rect(625, 680, 30, 30), PANEL, WINDOW)).toEqual({
      x: 640 - 160,
      y: 680 - ANCHOR_GAP_PX - 400,
    });
    expect(placeAbove(rect(625, 680, 30, 30), PANEL, WINDOW, 0).y).toBe(680 - 400);
  });

  test('is kept the margin away from the left and right edges of the window', () => {
    expect(placeAbove(rect(0, 680, 30, 30), PANEL, WINDOW).x).toBe(PANEL_MARGIN_PX);
    expect(placeAbove(rect(1250, 680, 30, 30), PANEL, WINDOW).x).toBe(
      WINDOW.w - PANEL.w - PANEL_MARGIN_PX,
    );
  });

  test('a panel wider than the window sits at its left edge', () => {
    expect(placeAbove(rect(600, 680, 30, 30), { w: 2000, h: 100 }, WINDOW).x).toBe(PANEL_MARGIN_PX);
  });

  test('goes under the button when it does not fit above', () => {
    // Above it would start at 100 - 8 - 400 < 0. Under: 30 below the top of the button, and a gap.
    const placed = placeAbove(rect(600, 100, 30, 30), PANEL, WINDOW);
    expect(placed.y).toBe(100 + 30 + ANCHOR_GAP_PX);
  });

  test('stays above the button when it fits exactly down to the margin', () => {
    const low = { w: 320, h: 200 };
    const top = PANEL_MARGIN_PX + ANCHOR_GAP_PX + low.h;
    expect(placeAbove(rect(600, top, 30, 30), low, WINDOW).y).toBe(PANEL_MARGIN_PX);
    // One pixel less room: under the button.
    expect(placeAbove(rect(600, top - 1, 30, 30), low, WINDOW).y).toBe(top - 1 + 30 + ANCHOR_GAP_PX);
  });

  test('is held inside the window when it fits neither above nor below', () => {
    // 500 high in a window 720 high, the button in the middle: under it would run off the bottom.
    const placed = placeAbove(rect(600, 300, 30, 30), { w: 320, h: 500 }, WINDOW);
    expect(placed.y).toBe(WINDOW.h - 500 - PANEL_MARGIN_PX);
    // And a panel taller than the window sits at the top.
    expect(placeAbove(rect(600, 300, 30, 30), { w: 320, h: 900 }, WINDOW).y).toBe(PANEL_MARGIN_PX);
  });

  test('works from a button measured in px of a smaller window', () => {
    const small = { w: 400, h: 300 };
    const placed = placeAbove(rect(380, 250, 30, 30), { w: 330, h: 200 }, small);
    expect(placed.x).toBe(small.w - 330 - PANEL_MARGIN_PX);
    expect(placed.y).toBe(250 - ANCHOR_GAP_PX - 200);
  });
});
