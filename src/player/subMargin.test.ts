import { invoke } from '@tauri-apps/api/core';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { SUB_MARGIN_GAP_PX, subMarginFor, useSubMargin } from './subMargin';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

test('sub margin scales to 720', () => expect(subMarginFor(120, 1080)).toBe(80));

describe('subMarginFor', () => {
  test('is the island scaled to the 720 px window mpv measures in, rounded', () => {
    // A 720 px window is the scale itself.
    expect(subMarginFor(100, 720)).toBe(100);
    // A smaller window has the island bigger in proportion.
    expect(subMarginFor(100, 360)).toBe(200);
    expect(subMarginFor(100, 2160)).toBe(33);
    // 95.625 and 112.5 go to the nearer whole number.
    expect(subMarginFor(102, 768)).toBe(96);
    expect(subMarginFor(120, 768)).toBe(113);
  });

  test('is held to 0 to 720, which is what Rust takes', () => {
    expect(subMarginFor(5000, 300)).toBe(720);
    expect(subMarginFor(-20, 1080)).toBe(0);
  });

  test('is 0 when there is nothing to measure', () => {
    expect(subMarginFor(0, 1080)).toBe(0);
    expect(subMarginFor(120, 0)).toBe(0);
    expect(subMarginFor(Number.NaN, 1080)).toBe(0);
    expect(subMarginFor(120, Number.NaN)).toBe(0);
  });
});

describe('useSubMargin', () => {
  const realHeight = window.innerHeight;
  let island: HTMLElement;
  /** The island's top edge, px from the top of the window. */
  let top: number;

  /** The margins mpv was told, in order. */
  const margins = (): unknown[] =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'player_command')
      .map(([, args]) => (args as { cmd: { type: string; margin?: number } }).cmd)
      .filter((cmd) => cmd.type === 'setSubMargin')
      .map((cmd) => cmd.margin);

  const setWindowHeight = (height: number) => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
  };

  beforeEach(() => {
    vi.mocked(invoke).mockClear();
    setWindowHeight(768);
    top = 660;
    island = document.createElement('div');
    vi.spyOn(island, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          left: 100,
          top,
          width: 800,
          height: 92,
          right: 900,
          bottom: top + 92,
          x: 100,
          y: top,
        }) as DOMRect,
    );
  });

  afterEach(() => {
    setWindowHeight(realHeight);
  });

  test('lifts the subtitles above the island while it is shown, and drops them when it hides or goes', () => {
    const ref = { current: island };
    const above = subMarginFor(768 - top + SUB_MARGIN_GAP_PX, 768);
    expect(above).toBeGreaterThan(0);

    const { rerender, unmount } = renderHook(({ hidden }) => {
      useSubMargin(ref, hidden);
    }, { initialProps: { hidden: false } });
    expect(margins()).toEqual([above]);

    // Faded out: 0, once.
    rerender({ hidden: true });
    expect(margins()).toEqual([above, 0]);

    rerender({ hidden: false });
    expect(margins()).toEqual([above, 0, above]);

    // Gone: nothing is above the subtitles.
    unmount();
    expect(margins()).toEqual([above, 0, above, 0]);
  });

  test('sends when the size changes, not for a measure that finds the same', () => {
    const ref = { current: island };
    renderHook(() => {
      useSubMargin(ref, false);
    });
    const first = margins();
    expect(first).toHaveLength(1);

    // The same window, measured again (the observer, a resize that changed nothing): nothing.
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
    expect(margins()).toEqual(first);

    // The window is taller: the island is a smaller share of it.
    setWindowHeight(1080);
    top = 972;
    window.dispatchEvent(new Event('resize'));
    expect(margins()).toEqual([...first, subMarginFor(1080 - top + SUB_MARGIN_GAP_PX, 1080)]);
  });

  test('measures again where the island stops after sliding in', () => {
    const ref = { current: island };
    // It starts a few px low while it slides in.
    top = 672;
    renderHook(() => {
      useSubMargin(ref, false);
    });
    const sliding = subMarginFor(768 - 672 + SUB_MARGIN_GAP_PX, 768);

    top = 660;
    island.dispatchEvent(new Event('transitionend'));
    expect(margins()).toEqual([sliding, subMarginFor(768 - 660 + SUB_MARGIN_GAP_PX, 768)]);
  });
});
