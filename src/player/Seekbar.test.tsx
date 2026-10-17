import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';

import { initI18n } from '../i18n';
import { shouldForward } from '../input/forward';
import { usePlayerStore, type PlayerProps } from '../state/playerStore';
import Seekbar, {
  DRAG_THROTTLE_MS,
  HOVER_THROTTLE_MS,
  KEY_SEEK_SECONDS,
  seekKeyCommand,
} from './Seekbar';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

/** The bar is 1000 px wide from the left edge of the window: a pointer at x is x seconds in a 1000 s file. */
let measured: MockInstance<() => DOMRect>;

beforeAll(() => {
  initI18n('en');
  // jsdom has no pointer capture.
  Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockClear();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({ left: 0, top: 0, width: 1000, height: 20, right: 1000, bottom: 20, x: 0, y: 0 }) as DOMRect,
  );
});

afterEach(() => {
  measured.mockRestore();
  vi.useRealTimers();
});

/** A paused file (so that no clock runs), `props` on top. */
function open(props: PlayerProps = {}) {
  usePlayerStore.setState({
    loaded: true,
    props: { 'idle-active': false, pause: true, 'time-pos': 10, duration: 1000, ...props },
  });
}

/** What was sent to a Tauri command, each call. */
const sent = (command: string): unknown[] =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([name]) => name === command)
    .map(([, args]) => args);

/** The `player_command`s of one kind, each call. */
const playerCommands = (type: string): Record<string, unknown>[] =>
  sent('player_command')
    .map((args) => (args as { cmd: Record<string, unknown> }).cmd)
    .filter((cmd) => cmd['type'] === type);

/** The seconds of the previews asked for, each call. */
const previews = (): unknown[] => sent('thumb_request').map((args) => (args as { seconds: number }).seconds);

const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

const seekbar = () => screen.getByRole('slider', { name: 'Seek' });

test('seek drag sends throttled keyframe seeks and one exact seek at release', () => {
  open();
  render(<Seekbar />);
  const bar = seekbar();

  expect(DRAG_THROTTLE_MS).toBe(50);
  // The press, then 20 moves within 200 ms, 10 ms apart: x = 110, 120, …, 300.
  fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 100 });
  for (let move = 1; move <= 20; move += 1) {
    advance(10);
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 100 + move * 10 });
  }
  const keyframes = playerCommands('seek').filter((cmd) => cmd['exact'] === false);
  expect(keyframes.length).toBeGreaterThanOrEqual(2);
  expect(keyframes.length).toBeLessThanOrEqual(5);
  // Nothing but absolute keyframe seeks while it drags; the first one is where the press was.
  expect(keyframes.every((cmd) => cmd['mode'] === 'absolute')).toBe(true);
  expect(keyframes[0]).toEqual({ type: 'seek', target: 100, mode: 'absolute', exact: false });
  expect(playerCommands('seek').filter((cmd) => cmd['exact'] === true)).toHaveLength(0);

  // The release: one exact seek to where the pointer is, and the seek held back is dropped.
  fireEvent.pointerUp(bar, { button: 0, pointerId: 1, clientX: 300 });
  const exact = playerCommands('seek').filter((cmd) => cmd['exact'] === true);
  expect(exact).toEqual([{ type: 'seek', target: 300, mode: 'absolute', exact: true }]);
  const total = playerCommands('seek').length;
  advance(500);
  expect(playerCommands('seek')).toHaveLength(total);
});

test('a quick click seeks to the keyframe and then exactly, once each', () => {
  open();
  render(<Seekbar />);
  const bar = seekbar();
  fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 400 });
  advance(20);
  fireEvent.pointerUp(bar, { button: 0, pointerId: 1, clientX: 400 });

  expect(playerCommands('seek')).toEqual([
    { type: 'seek', target: 400, mode: 'absolute', exact: false },
    { type: 'seek', target: 400, mode: 'absolute', exact: true },
  ]);
});

test('the bar seeks only from the primary button, and only once the length is known', () => {
  open();
  const { unmount } = render(<Seekbar />);
  fireEvent.pointerDown(seekbar(), { button: 2, pointerId: 1, clientX: 400 });
  fireEvent.pointerUp(seekbar(), { button: 2, pointerId: 1, clientX: 400 });
  expect(playerCommands('seek')).toEqual([]);
  unmount();

  // A stream that does not know its length.
  open({ duration: null });
  render(<Seekbar />);
  fireEvent.pointerDown(seekbar(), { button: 0, pointerId: 1, clientX: 400 });
  fireEvent.pointerMove(seekbar(), { pointerId: 1, clientX: 450 });
  fireEvent.pointerUp(seekbar(), { button: 0, pointerId: 1, clientX: 450 });
  expect(playerCommands('seek')).toEqual([]);
  expect(previews()).toEqual([]);
});

test('thumb requests are throttled to one per 30 ms', () => {
  open();
  render(<Seekbar />);
  const bar = seekbar();
  expect(HOVER_THROTTLE_MS).toBe(30);

  // Ten moves, 5 ms apart (t = 0, 5, …, 45), x = 100, 110, … 190.
  for (let move = 0; move < 10; move += 1) {
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 100 + move * 10 });
    advance(5);
  }
  // At t = 50: the first at once, and the newest of those held back when 30 ms were over (x = 150).
  expect(previews()).toEqual([100, 150]);

  // The next 30 ms are over at t = 60: the newest since then (x = 190).
  advance(10);
  expect(previews()).toEqual([100, 150, 190]);

  // Nothing is asked for twice while the pointer rests.
  advance(1000);
  expect(previews()).toHaveLength(3);
});

test('leaving the bar clears the preview, and nothing held back is asked for afterwards', () => {
  open();
  render(<Seekbar />);
  const bar = seekbar();
  fireEvent.pointerMove(bar, { pointerId: 1, clientX: 100 });
  fireEvent.pointerMove(bar, { pointerId: 1, clientX: 200 });
  expect(previews()).toEqual([100]);
  expect(sent('thumb_clear')).toHaveLength(0);

  fireEvent.pointerLeave(bar);
  expect(sent('thumb_clear')).toHaveLength(1);
  advance(500);
  expect(previews()).toEqual([100]);
});

test('the time under the pointer is shown in the bubble', () => {
  open();
  render(<Seekbar />);
  fireEvent.pointerMove(seekbar(), { pointerId: 1, clientX: 125 });
  // 125 s of a 1000 s file; the bubble has the time, and it is the one of the pointer.
  expect(screen.getByText('2:05')).toBeTruthy();
});

describe('the keyboard', () => {
  test('the arrows seek 5 s and say so, so that mpv does not get them again', () => {
    open();
    render(<Seekbar />);
    const bar = seekbar();
    expect(KEY_SEEK_SECONDS).toBe(5);

    for (const [key, target] of [
      ['ArrowRight', 5],
      ['ArrowLeft', -5],
    ] as const) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      bar.dispatchEvent(event);
      expect(event.defaultPrevented, key).toBe(true);
      // The listener that passes keys on to mpv (input/forward.ts) leaves it alone.
      expect(shouldForward(event), key).toBe(false);
      expect(playerCommands('seek').at(-1), key).toEqual({
        type: 'seek',
        target,
        mode: 'relative',
        exact: false,
      });
    }
    expect(playerCommands('seek')).toHaveLength(2);
  });

  test('Home goes to the start and End to the end', () => {
    open();
    render(<Seekbar />);
    const bar = seekbar();

    const home = new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true });
    bar.dispatchEvent(home);
    const end = new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true });
    bar.dispatchEvent(end);

    expect(home.defaultPrevented && end.defaultPrevented).toBe(true);
    expect(playerCommands('seek')).toEqual([
      { type: 'seek', target: 0, mode: 'absolute', exact: false },
      { type: 'seek', target: 100, mode: 'absolutePercent', exact: false },
    ]);
  });

  test('other keys, and keys with a modifier, are left to mpv', () => {
    open();
    render(<Seekbar />);
    const bar = seekbar();

    for (const init of [
      { key: 'ArrowUp' },
      { key: ' ' },
      { key: 'ArrowRight', ctrlKey: true },
      { key: 'ArrowRight', shiftKey: true },
      { key: 'ArrowLeft', altKey: true },
    ]) {
      const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
      bar.dispatchEvent(event);
      expect(event.defaultPrevented, JSON.stringify(init)).toBe(false);
      // Ctrl and the like are not Windows' shortcuts: they go on to mpv.
      expect(shouldForward(event), JSON.stringify(init)).toBe(true);
    }
    expect(playerCommands('seek')).toEqual([]);
  });

  test('without a length the keys are mpv’s', () => {
    open({ duration: null });
    render(<Seekbar />);
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    seekbar().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(playerCommands('seek')).toEqual([]);
  });

  test('seekKeyCommand names what each key does', () => {
    expect(seekKeyCommand('ArrowLeft')).toEqual({ type: 'seek', target: -5, mode: 'relative', exact: false });
    expect(seekKeyCommand('ArrowRight')).toEqual({ type: 'seek', target: 5, mode: 'relative', exact: false });
    expect(seekKeyCommand('Home')).toEqual({ type: 'seek', target: 0, mode: 'absolute', exact: false });
    expect(seekKeyCommand('End')).toEqual({
      type: 'seek',
      target: 100,
      mode: 'absolutePercent',
      exact: false,
    });
    expect(seekKeyCommand('PageUp')).toBeNull();
    expect(seekKeyCommand('ArrowRight', { meta: true })).toBeNull();
  });

  test('the bar is a slider in the tab order, with the position for a screen reader', () => {
    open({ 'time-pos': 10, duration: 3600 });
    render(<Seekbar />);
    const bar = seekbar();
    expect(bar.getAttribute('tabindex')).toBe('0');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('3600');
    expect(bar.getAttribute('aria-valuenow')).toBe('10');
    // A film of an hour: both times with the hours.
    expect(bar.getAttribute('aria-valuetext')).toBe('0:00:10 of 1:00:00');
  });
});

describe('what it shows', () => {
  test('the time and the length, as a clock', () => {
    open({ 'time-pos': 75, duration: 600 });
    render(<Seekbar />);
    expect(screen.getByText('1:15')).toBeTruthy();
    expect(screen.getByText('10:00')).toBeTruthy();
  });

  test('the times are set in numerals of one width', () => {
    open({ 'time-pos': 75, duration: 600 });
    render(<Seekbar />);
    expect(screen.getByText('1:15').classList.contains('tabular')).toBe(true);
    expect(screen.getByText('10:00').classList.contains('tabular')).toBe(true);
  });

  test('a mark for each chapter that starts inside the file', () => {
    open({
      duration: 1000,
      'chapter-list': [
        { title: 'Intro', time: 0 },
        { title: 'One', time: 250 },
        { title: 'Two', time: 500 },
        { title: 'Past the end', time: 1500 },
      ],
    });
    render(<Seekbar />);
    const marks = [...seekbar().querySelectorAll<HTMLElement>('span[style*="left"]')];
    expect(marks.map((mark) => mark.style.left)).toEqual(['25%', '50%']);
  });

  test('the bar shows where a drag is, not where mpv still is', () => {
    open({ 'time-pos': 10 });
    render(<Seekbar />);
    expect(screen.getByText('0:10')).toBeTruthy();

    fireEvent.pointerDown(seekbar(), { button: 0, pointerId: 1, clientX: 600 });
    // 600 s of 1000 s: the time of the bar and the time in the bubble; the old time is gone.
    expect(screen.queryByText('0:10')).toBeNull();
    expect(screen.getAllByText('10:00').length).toBeGreaterThanOrEqual(1);
    // The length does not move with it.
    expect(screen.getByText('16:40')).toBeTruthy();
  });
});
