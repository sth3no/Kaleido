import { describe, expect, it } from 'vitest';
import { buttonName, toSurfacePoint, wheelKey } from './mouse';

const surface = { left: 10, top: 10, width: 200, height: 100 };

describe('toSurfacePoint', () => {
  it('converts CSS client coordinates to physical surface pixels', () => {
    expect(toSurfacePoint(110, 60, surface, 1.5)).toEqual({ x: 150, y: 75 });
  });
  it('is null outside the surface', () => {
    expect(toSurfacePoint(5, 60, surface, 1)).toBeNull();
    expect(toSurfacePoint(210, 60, surface, 1)).toBeNull();
  });
});

describe('buttonName', () => {
  it.each([[0, 'MBTN_LEFT'], [1, 'MBTN_MID'], [2, 'MBTN_RIGHT'], [3, 'MBTN_BACK'], [4, 'MBTN_FORWARD'], [7, null]])(
    '%i → %s',
    (n, name) => expect(buttonName(n)).toBe(name),
  );
});

describe('wheelKey', () => {
  it.each([
    [0, -100, 'WHEEL_UP'],
    [0, 50, 'WHEEL_DOWN'],
    [-30, 5, 'WHEEL_LEFT'],
    [30, 0, 'WHEEL_RIGHT'],
    [0, 0, null],
  ])('(%i, %i) → %s', (dx, dy, key) => expect(wheelKey(dx, dy)).toBe(key));
});
