import { expect, test } from 'vitest';

import { WheelAccumulator } from './wheel';

const PIXELS = 0;
const LINES = 1;
const PAGES = 2;

const turn = (deltaY: number, deltaMode = PIXELS, deltaX = 0) => ({ deltaX, deltaY, deltaMode });

test('wheel accumulates touchpad deltas into whole steps', () => {
  const w = new WheelAccumulator();
  expect(w.push({ deltaX: 0, deltaY: -30, deltaMode: 0 })).toBeNull();
  expect(w.push({ deltaX: 0, deltaY: -30, deltaMode: 0 })).toBeNull();
  expect(w.push({ deltaX: 0, deltaY: -40, deltaMode: 0 })).toEqual({ key: 'WHEEL_UP', steps: 1 });
});

test('a change of direction drops the leftover', () => {
  const w = new WheelAccumulator();
  expect(w.push(turn(-60))).toBeNull();
  expect(w.push(turn(60))).toBeNull();
  // Had the 60 px up been kept, the 60 px down and these 40 would not make a notch.
  expect(w.push(turn(40))).toEqual({ key: 'WHEEL_DOWN', steps: 1 });
});

test('a change of axis drops the leftover too', () => {
  const w = new WheelAccumulator();
  expect(w.push(turn(70))).toBeNull();
  expect(w.push(turn(0, PIXELS, 70))).toBeNull();
  expect(w.push(turn(0, PIXELS, 30))).toEqual({ key: 'WHEEL_RIGHT', steps: 1 });
});

test('the leftover is kept after a step', () => {
  const w = new WheelAccumulator();
  expect(w.push(turn(130))).toEqual({ key: 'WHEEL_DOWN', steps: 1 });
  expect(w.push(turn(30))).toBeNull();
  expect(w.push(turn(40))).toEqual({ key: 'WHEEL_DOWN', steps: 1 });
});

test('a notched mouse wheel gives one step per notch, in any direction', () => {
  const w = new WheelAccumulator();
  expect(w.push(turn(-100))).toEqual({ key: 'WHEEL_UP', steps: 1 });
  expect(w.push(turn(100))).toEqual({ key: 'WHEEL_DOWN', steps: 1 });
  expect(w.push(turn(0, PIXELS, -100))).toEqual({ key: 'WHEEL_LEFT', steps: 1 });
  expect(w.push(turn(0, PIXELS, 100))).toEqual({ key: 'WHEEL_RIGHT', steps: 1 });
});

test('a fast spin gives several steps, capped at ten', () => {
  const w = new WheelAccumulator();
  expect(w.push(turn(-300))).toEqual({ key: 'WHEEL_UP', steps: 3 });
  expect(w.push(turn(-5000))).toEqual({ key: 'WHEEL_UP', steps: 10 });
  // What was over the cap is gone, not saved for later.
  expect(w.push(turn(-50))).toBeNull();
});

test('a notch is 3 lines or 1 page', () => {
  const w = new WheelAccumulator();
  expect(w.push(turn(1, LINES))).toBeNull();
  expect(w.push(turn(1, LINES))).toBeNull();
  expect(w.push(turn(1, LINES))).toEqual({ key: 'WHEEL_DOWN', steps: 1 });
  expect(w.push(turn(2, PAGES))).toEqual({ key: 'WHEEL_DOWN', steps: 2 });
  expect(w.push(turn(0.5, PAGES))).toBeNull();
  expect(w.push(turn(0.5, PAGES))).toEqual({ key: 'WHEEL_DOWN', steps: 1 });
});

test('many small deltas add up to one notch despite the rounding of fractions', () => {
  const step = { key: 'WHEEL_DOWN', steps: 1 };
  const pixels = new WheelAccumulator();
  const fromPixels = Array.from({ length: 10 }, () => pixels.push(turn(10)));
  expect(fromPixels).toEqual([...Array<null>(9).fill(null), step]);

  const lines = new WheelAccumulator();
  const fromLines = Array.from({ length: 30 }, () => lines.push(turn(0.1, LINES)));
  expect(fromLines).toEqual([...Array<null>(29).fill(null), step]);
});

test('an event that moved nothing gives nothing and keeps the leftover', () => {
  const w = new WheelAccumulator();
  expect(w.push(turn(60))).toBeNull();
  expect(w.push(turn(0))).toBeNull();
  expect(w.push(turn(40))).toEqual({ key: 'WHEEL_DOWN', steps: 1 });
});
