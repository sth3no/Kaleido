import { describe, expect, it } from 'vitest';
import { animateRect, easeOutCubic, lerpRect, miniRect } from './mini';

describe('mini player geometry', () => {
  it('eases from 0 to 1', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  it('interpolates rectangles', () => {
    expect(lerpRect({ x: 0, y: 0, w: 100, h: 50 }, { x: 100, y: 50, w: 200, h: 150 }, 0.5)).toEqual({
      x: 50, y: 25, w: 150, h: 100,
    });
  });

  it('places a 16:9 mini player bottom-right', () => {
    expect(miniRect(1280, 720)).toEqual({ x: 896, y: 493, w: 360, h: 203 });
  });

  it('shrinks the mini player in a narrow window', () => {
    expect(miniRect(300, 400).w).toBe(252);
  });
});

describe('animateRect', () => {
  it('reports frames and ends exactly on the target', async () => {
    let t = 0;
    const frames: number[] = [];
    const raf = (cb: () => void) => {
      t += 50;
      cb();
      return 0;
    };
    const to = { x: 10, y: 10, w: 10, h: 10 };
    await animateRect({ x: 0, y: 0, w: 0, h: 0 }, to, 200, (r) => frames.push(r.x), () => t, raf);
    expect(frames.length).toBe(4);
    expect(frames.at(-1)).toBe(10);
  });
});
