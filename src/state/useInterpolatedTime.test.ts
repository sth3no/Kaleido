import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { usePlayerStore, type PlayerProps } from './playerStore';
import { useInterpolatedTime } from './useInterpolatedTime';

// The animation frames and the clock are the test's: `advance` lets time pass and runs the frames
// that were asked for, once, at the end of it.
let now = 0;
let nextFrame = 1;
const frames = new Map<number, FrameRequestCallback>();

const advance = (ms: number) => {
  act(() => {
    now += ms;
    const due = [...frames.values()];
    frames.clear();
    for (const run of due) run(now);
  });
};

const apply = (changes: PlayerProps) => {
  act(() => {
    usePlayerStore.getState().applyChanges(changes);
  });
};

/** A file that plays at normal speed, 10 s in, unless `changes` say otherwise. */
const play = (changes: PlayerProps = {}) => {
  usePlayerStore.getState().applySnapshot({
    'idle-active': false,
    pause: false,
    'time-pos': 10,
    duration: 100,
    speed: 1,
    ...changes,
  });
  // As in the player: mpv says the file is loaded.
  usePlayerStore.getState().fileLoaded();
};

beforeEach(() => {
  now = 0;
  nextFrame = 1;
  frames.clear();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
    frames.set(nextFrame, run);
    return nextFrame++;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('interpolates between updates and stops when paused', () => {
  play({ speed: 2 });
  const { result } = renderHook(() => useInterpolatedTime());
  expect(result.current).toBe(10);

  advance(500);
  // 10 s + 0.5 s at double speed.
  expect(result.current).toBeCloseTo(11, 6);

  // mpv sends the time it stopped at together with the pause.
  apply({ pause: true, 'time-pos': 11 });
  expect(frames.size).toBe(0);
  advance(1000);
  expect(result.current).toBe(11);

  apply({ pause: false });
  expect(frames.size).toBe(1);
  advance(250);
  expect(result.current).toBeCloseTo(11.5, 6);
});

test('a new time-pos is shown at once and the time runs on from it', () => {
  play();
  const { result } = renderHook(() => useInterpolatedTime());
  advance(100);
  expect(result.current).toBeCloseTo(10.1, 6);

  // The player's own time is a little behind or ahead of the guess: no jump past it.
  apply({ 'time-pos': 10.05 });
  expect(result.current).toBe(10.05);
  advance(200);
  expect(result.current).toBeCloseTo(10.25, 6);
});

test('a change of speed runs the time at the new speed', () => {
  play();
  const { result } = renderHook(() => useInterpolatedTime());
  advance(1000);
  expect(result.current).toBeCloseTo(11, 6);
  apply({ speed: 4, 'time-pos': 11 });
  advance(500);
  expect(result.current).toBeCloseTo(13, 6);
});

test('a change of speed alone does not take the time back to the last time-pos', () => {
  play();
  const { result } = renderHook(() => useInterpolatedTime());
  advance(600);
  expect(result.current).toBeCloseTo(10.6, 6);

  apply({ speed: 2 });
  // Still where it had run to, not at the 10 of the last time-pos.
  expect(result.current).toBeCloseTo(10.6, 6);
  advance(200);
  expect(result.current).toBeCloseTo(11, 6);
});

test('a pause without a time-pos freezes the time where it had run to', () => {
  play({ speed: 2 });
  const { result } = renderHook(() => useInterpolatedTime());
  advance(500);
  expect(result.current).toBeCloseTo(11, 6);

  // The pause comes alone: the last time-pos is still the 10 from before.
  apply({ pause: true });
  expect(result.current).toBeCloseTo(11, 6);
  expect(frames.size).toBe(0);
  advance(2000);
  expect(result.current).toBeCloseTo(11, 6);

  // Until the player says where it is.
  apply({ 'time-pos': 11.02 });
  expect(result.current).toBe(11.02);
});

test('resuming with the same time-pos starts from the frozen time, not from the old one', () => {
  play({ speed: 2 });
  const { result } = renderHook(() => useInterpolatedTime());
  advance(500);
  apply({ pause: true });
  expect(result.current).toBeCloseTo(11, 6);

  apply({ pause: false });
  // The first frame after the resume shows the frozen time, not the 10 of the last time-pos.
  expect(result.current).toBeCloseTo(11, 6);
  expect(frames.size).toBe(1);
  advance(250);
  expect(result.current).toBeCloseTo(11.5, 6);
});

test('a time-pos that arrives after the file ended does not start the loop again', () => {
  play();
  const { result } = renderHook(() => useInterpolatedTime());
  advance(500);

  act(() => {
    usePlayerStore.getState().endFile({ reason: 'eof', error: null, file: null, continues: false });
  });
  // end-file comes before idle-active turns true, and a late time-pos can follow it.
  apply({ 'time-pos': 42 });
  expect(frames.size).toBe(0);
  advance(1000);
  expect(result.current).toBe(42);
});

test('the time does not run past the end of the file', () => {
  play({ 'time-pos': 99.5 });
  const { result } = renderHook(() => useInterpolatedTime());
  advance(2000);
  expect(result.current).toBe(100);
});

test('no loop runs while the player is paused, seeking, stalled, idle or at the end', () => {
  const cases: [PlayerProps, number][] = [
    [{ pause: true }, 10],
    [{ seeking: true }, 10],
    [{ 'paused-for-cache': true }, 10],
    [{ 'eof-reached': true }, 10],
    // Nothing is open, or the file has no time yet: there is nothing to show.
    [{ 'idle-active': true }, 0],
    [{ 'time-pos': null }, 0],
  ];
  for (const [changes, shown] of cases) {
    usePlayerStore.setState(usePlayerStore.getInitialState(), true);
    play(changes);
    const { result, unmount } = renderHook(() => useInterpolatedTime());
    expect(frames.size, JSON.stringify(changes)).toBe(0);
    advance(1000);
    expect(result.current, JSON.stringify(changes)).toBe(shown);
    unmount();
  }
});

test('a stale time-pos after the end of a file shows nothing', () => {
  play();
  const { result } = renderHook(() => useInterpolatedTime());
  apply({ 'idle-active': true, 'time-pos': 42 });
  expect(result.current).toBe(0);
  expect(frames.size).toBe(0);
});

test('the loop exists only while someone uses the hook', () => {
  play();
  // Nobody draws the time (the controls are hidden): the player plays and nothing is asked for.
  apply({ 'time-pos': 10.5 });
  expect(frames.size).toBe(0);

  const first = renderHook(() => useInterpolatedTime());
  expect(frames.size).toBe(1);
  const second = renderHook(() => useInterpolatedTime());
  first.unmount();
  expect(frames.size).toBe(1);
  second.unmount();
  expect(frames.size).toBe(0);
});
