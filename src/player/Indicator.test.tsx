import { act, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../i18n';
import { usePlayerStore } from '../state/playerStore';
import Indicator, { INDICATOR_FADE_MS, INDICATOR_MS } from './Indicator';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
const events = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    events.handlers.set(name, handler);
    return Promise.resolve(() => undefined);
  }),
}));

/** The timers the tests move (not `setImmediate`, which React's `act` waits on). */
const FAKE: NonNullable<Parameters<typeof vi.useFakeTimers>[0]>['toFake'] = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'Date',
  'performance',
  'requestAnimationFrame',
  'cancelAnimationFrame',
];

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: FAKE });
  events.handlers.clear();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
});

afterEach(() => {
  vi.useRealTimers();
  setLanguage('en');
});

/** Rust sends `script-message kaleido <args>`: `player:message` without the `kaleido`. */
function message(...args: string[]) {
  const handler = events.handlers.get('player:message');
  if (!handler) throw new Error('the indicator does not listen to player:message');
  act(() => {
    handler({ payload: { args } });
  });
}

const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

const set = (changes: Record<string, unknown>) => {
  act(() => {
    usePlayerStore.getState().applyChanges(changes);
  });
};

const capsule = () => screen.getByRole('status');
const shown = () => capsule().getAttribute('data-shown');

test('indicator shows the value for one second', () => {
  set({ volume: 52 });
  render(<Indicator />);
  // Always in the page, so that a screen reader hears the text arrive; nothing to see yet.
  expect(shown()).toBe('false');
  expect(capsule().textContent).toBe('');

  message('osd', 'volume');
  expect(shown()).toBe('true');
  expect(within(capsule()).getByText('52%')).toBeTruthy();
  // For a screen reader the value has its name.
  expect(within(capsule()).getByText('Volume')).toBeTruthy();

  advance(INDICATOR_MS - 1);
  expect(shown()).toBe('true');
  advance(1);
  // Fading: the value stays until it has faded.
  expect(shown()).toBe('false');
  expect(within(capsule()).getByText('52%')).toBeTruthy();

  advance(INDICATOR_FADE_MS);
  expect(capsule().textContent).toBe('');
  expect(shown()).toBe('false');
});

test('every message starts the second again', () => {
  render(<Indicator />);

  message('osd', 'volume');
  advance(800);
  message('osd', 'volume');
  advance(800);
  expect(shown()).toBe('true');

  advance(200);
  expect(shown()).toBe('false');
});

test('a message while it fades brings it back', () => {
  render(<Indicator />);
  message('osd', 'speed');
  advance(INDICATOR_MS + 10);
  expect(shown()).toBe('false');

  message('osd', 'volume');
  expect(shown()).toBe('true');
  // The readout of the first message was not taken away under the second.
  advance(INDICATOR_FADE_MS);
  expect(shown()).toBe('true');
  expect(within(capsule()).getByText('Volume')).toBeTruthy();
});

describe('the value comes from the store, also when it comes after the message', () => {
  test('the volume', () => {
    set({ volume: 50 });
    render(<Indicator />);

    // mpv may send the message before the property change it is about.
    message('osd', 'volume');
    expect(within(capsule()).getByText('50%')).toBeTruthy();

    set({ volume: 52 });
    expect(within(capsule()).getByText('52%')).toBeTruthy();
    expect(within(capsule()).queryByText('50%')).toBeNull();
  });

  test('the speed', () => {
    set({ speed: 1 });
    render(<Indicator />);

    message('osd', 'speed');
    expect(within(capsule()).getByText('1×')).toBeTruthy();

    // The numbers of multiplying by 1.1 are cut to two places.
    set({ speed: 1.2100000000000002 });
    expect(within(capsule()).getByText('1.21×')).toBeTruthy();
    expect(within(capsule()).getByText('Speed')).toBeTruthy();
  });

  test('the place in the file, with its length', () => {
    set({ 'idle-active': false, 'time-pos': 60, duration: 600 });
    render(<Indicator />);

    message('osd', 'seek');
    expect(within(capsule()).getByText('1:00 of 10:00')).toBeTruthy();

    set({ 'time-pos': 65 });
    expect(within(capsule()).getByText('1:05 of 10:00')).toBeTruthy();
    expect(within(capsule()).getByText('Seek')).toBeTruthy();
  });

  test('a film of an hour or more is written with the hours on both sides', () => {
    set({ 'idle-active': false, 'time-pos': 90, duration: 7200 });
    render(<Indicator />);

    message('osd', 'seek');
    expect(within(capsule()).getByText('0:01:30 of 2:00:00')).toBeTruthy();
  });

  test('a stream that does not know its length yet shows the place alone', () => {
    set({ 'idle-active': false, 'time-pos': 75 });
    render(<Indicator />);

    message('osd', 'seek');
    expect(within(capsule()).getByText('1:15')).toBeTruthy();
  });
});

test('mute is a word, not a number', () => {
  set({ volume: 52, mute: true });
  render(<Indicator />);

  message('osd', 'volume');
  expect(within(capsule()).getByText('Muted')).toBeTruthy();
  expect(within(capsule()).queryByText('52%')).toBeNull();

  set({ mute: false });
  expect(within(capsule()).getByText('52%')).toBeTruthy();
});

test('the texts follow the language', () => {
  set({ volume: 52 });
  render(<Indicator />);
  message('osd', 'volume');

  act(() => {
    setLanguage('cs');
  });

  // Czech writes a space before the percent sign.
  expect(within(capsule()).getByText(/^52\s%$/)).toBeTruthy();
  expect(within(capsule()).getByText('Hlasitost')).toBeTruthy();
});

test('other messages, and things to show that it does not know, show nothing', () => {
  render(<Indicator />);

  message('screenshot', 'video');
  message('paste');
  message('open');
  message('osd');
  message('osd', 'bogus');
  message('osd', 'constructor');

  expect(shown()).toBe('false');
  expect(capsule().textContent).toBe('');
});

test('it is a polite live region, which a screen reader reads whole', () => {
  render(<Indicator />);

  expect(capsule().getAttribute('aria-live')).toBe('polite');
  expect(capsule().getAttribute('aria-atomic')).toBe('true');
  // It takes no pointer and no focus.
  expect(capsule().hasAttribute('tabindex')).toBe(false);
});

test('under StrictMode, which mounts effects twice, a message is one second, not two', () => {
  render(
    <StrictMode>
      <Indicator />
    </StrictMode>,
  );

  message('osd', 'volume');
  expect(shown()).toBe('true');
  advance(INDICATOR_MS);
  expect(shown()).toBe('false');
});
