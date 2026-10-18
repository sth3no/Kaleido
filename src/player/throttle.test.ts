import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { throttle } from './throttle';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('the first call goes at once and the ones within the interval give way to the newest', () => {
  const run = vi.fn<(value: number) => void>();
  const throttled = throttle(run, 30);

  throttled(1);
  expect(run.mock.calls).toEqual([[1]]);

  vi.advanceTimersByTime(10);
  throttled(2);
  vi.advanceTimersByTime(10);
  throttled(3);
  // Held back: nothing more has gone.
  expect(run).toHaveBeenCalledTimes(1);

  // The interval is over: the newest goes, 2 is dropped.
  vi.advanceTimersByTime(10);
  expect(run.mock.calls).toEqual([[1], [3]]);

  // Nothing was held during the next interval: nothing goes, and the one after goes at once.
  vi.advanceTimersByTime(30);
  expect(run).toHaveBeenCalledTimes(2);
  throttled(4);
  expect(run.mock.calls.at(-1)).toEqual([4]);
});

test('a steady stream goes once per interval, and its last value is not lost', () => {
  const run = vi.fn<(value: number) => void>();
  const throttled = throttle(run, 50);

  // One call every 10 ms for 200 ms: values 0 to 20.
  for (let value = 0; value <= 20; value += 1) {
    throttled(value);
    vi.advanceTimersByTime(10);
  }
  // At most one call per 50 ms (the first at once): 0, 5, 10, 15 and 20 at the latest.
  expect(run.mock.calls.length).toBeLessThanOrEqual(5);
  // The end of the movement arrives within one interval after it.
  vi.advanceTimersByTime(50);
  expect(run.mock.calls.at(-1)).toEqual([20]);
});

test('cancel drops the call that is held back, and the next call goes at once', () => {
  const run = vi.fn<(value: number) => void>();
  const throttled = throttle(run, 30);

  throttled(1);
  throttled(2);
  throttled.cancel();
  vi.advanceTimersByTime(100);
  expect(run.mock.calls).toEqual([[1]]);

  throttled(3);
  expect(run.mock.calls).toEqual([[1], [3]]);
});

test('flush sends the call that is held back at once, and the next call goes at once too', () => {
  const run = vi.fn<(value: number) => void>();
  const throttled = throttle(run, 30);

  throttled(1);
  throttled(2);
  throttled(3);
  expect(run.mock.calls).toEqual([[1]]);

  throttled.flush();
  expect(run.mock.calls).toEqual([[1], [3]]);

  // The interval it was in is over: the timer is gone, nothing goes twice.
  vi.advanceTimersByTime(100);
  expect(run).toHaveBeenCalledTimes(2);
  throttled(4);
  expect(run.mock.calls.at(-1)).toEqual([4]);
});

test('flush with nothing held sends nothing', () => {
  const run = vi.fn<(value: number) => void>();
  const throttled = throttle(run, 30);
  throttled.flush();
  expect(run).not.toHaveBeenCalled();
  throttled(1);
  throttled.flush();
  expect(run.mock.calls).toEqual([[1]]);
});
