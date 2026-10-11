import { describe, expect, it } from 'vitest';
import { measure, sameRects } from './regions';

const el = (x: number, y: number, width: number, height: number) => ({
  getBoundingClientRect: () => ({ x, y, width, height }),
});

describe('measure', () => {
  it('measures a visible capsule with its radius clamped to half the height', () => {
    expect(measure(el(10, 20, 300, 40), { borderTopLeftRadius: '999px', opacity: '1' })).toEqual({
      x: 10, y: 20, w: 300, h: 40, r: 20, a: 1,
    });
  });

  it('passes a fading opacity through as alpha', () => {
    expect(measure(el(0, 0, 100, 50), { borderTopLeftRadius: '24px', opacity: '0.4' })?.a).toBeCloseTo(0.4);
  });

  it('skips invisible and empty elements', () => {
    expect(measure(el(0, 0, 100, 50), { borderTopLeftRadius: '0px', opacity: '0' })).toBeNull();
    expect(measure(el(0, 0, 0, 50), { borderTopLeftRadius: '0px', opacity: '1' })).toBeNull();
  });
});

describe('sameRects', () => {
  const a = [{ x: 10, y: 10, w: 100, h: 40, r: 20, a: 1 }];
  it('treats sub-pixel jitter as unchanged', () => expect(sameRects(a, [{ ...a[0], x: 10.2 }])).toBe(true));
  it('notices real movement', () => expect(sameRects(a, [{ ...a[0], x: 12 }])).toBe(false));
  it('notices fades', () => expect(sameRects(a, [{ ...a[0], a: 0.5 }])).toBe(false));
  it('notices added or removed regions', () => expect(sameRects(a, [])).toBe(false));
});
