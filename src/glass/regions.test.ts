import { describe, expect, it } from 'vitest';

import { zoomFrame } from '../theme/zoom';
import { measure, sameRects } from './regions';

// Ported from the M0 prototype (prototype/src/glass/regions.test.ts); the boxes are DOMRect's
// left/top, which the video layer's tests mock as well.
const el = (left: number, top: number, width: number, height: number, currentCSSZoom?: number) => ({
  getBoundingClientRect: () => ({ left, top, width, height }),
  currentCSSZoom,
});

describe('measure', () => {
  it('measures a visible capsule with its radius clamped to half the height', () => {
    expect(measure(el(10, 20, 300, 40), { borderTopLeftRadius: '999px', opacity: '1' })).toEqual({
      x: 10,
      y: 20,
      w: 300,
      h: 40,
      r: 20,
      a: 1,
    });
  });

  it('passes a fading opacity through as alpha', () => {
    expect(measure(el(0, 0, 100, 50), { borderTopLeftRadius: '24px', opacity: '0.4' })?.a).toBeCloseTo(0.4);
    // The opacity it is shown with (its ancestors' too) wins over its own.
    expect(
      measure(el(0, 0, 100, 50), { borderTopLeftRadius: '24px', opacity: '1' }, { opacity: 0.25 })?.a,
    ).toBeCloseTo(0.25);
  });

  it('skips invisible and empty elements', () => {
    expect(measure(el(0, 0, 100, 50), { borderTopLeftRadius: '0px', opacity: '0' })).toBeNull();
    expect(measure(el(0, 0, 0, 50), { borderTopLeftRadius: '0px', opacity: '1' })).toBeNull();
    expect(
      measure(el(0, 0, 100, 50), { borderTopLeftRadius: '0px', opacity: '1', visibility: 'hidden' }),
    ).toBeNull();
    expect(measure(el(0, 0, 100, 50), { borderTopLeftRadius: '0px', opacity: '1' }, { opacity: 0 })).toBeNull();
  });

  it('takes a given radius over the border radius', () => {
    expect(measure(el(0, 0, 100, 50), { borderTopLeftRadius: '24px', opacity: '1' }, { radius: 12 })?.r).toBe(12);
  });

  it('is in CSS px of the window at 90 % and 150 %', () => {
    // The engine of today reports window px: the box stays, the radius (own CSS px) is zoomed.
    for (const zoom of [0.9, 1.5]) {
      const frame = zoomFrame(zoom, 1280, 1280);
      const rect = measure(el(24, 16, 300, 80), { borderTopLeftRadius: '20px', opacity: '1' }, { frame });
      expect(rect).toMatchObject({ x: 24, y: 16, w: 300, h: 80 });
      expect(rect?.r).toBeCloseTo(20 * zoom);
    }
    // An engine that reports the zoomed element's own px: the box is zoomed too.
    const rect = measure(el(16, 16, 200, 32), { borderTopLeftRadius: '999px', opacity: '1' }, {
      frame: zoomFrame(1.5, 1280 / 1.5, 1280),
    });
    expect(rect).toEqual({ x: 24, y: 24, w: 300, h: 48, r: 24, a: 1 });
  });
});

describe('sameRects', () => {
  const first = { x: 10, y: 10, w: 100, h: 40, r: 20, a: 1 };
  const a = [first];
  it('treats sub-pixel jitter as unchanged', () => expect(sameRects(a, [{ ...first, x: 10.2 }])).toBe(true));
  it('notices real movement', () => expect(sameRects(a, [{ ...first, x: 12 }])).toBe(false));
  it('notices fades', () => expect(sameRects(a, [{ ...first, a: 0.5 }])).toBe(false));
  it('notices added or removed regions', () => expect(sameRects(a, [])).toBe(false));
  it('counts a left-out opacity as full', () =>
    expect(sameRects(a, [{ x: 10, y: 10, w: 100, h: 40, r: 20 }])).toBe(true));
});
