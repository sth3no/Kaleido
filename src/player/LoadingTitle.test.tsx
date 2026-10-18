import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../i18n';
import { usePlayerStore, type PlayerProps } from '../state/playerStore';
import LoadingTitle, { LOADING_FADE_MS, loadingName, selectWaiting } from './LoadingTitle';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

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
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
});

afterEach(() => {
  vi.useRealTimers();
  setLanguage('en');
});

const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

const state = (props: PlayerProps, loaded = false) => {
  act(() => {
    usePlayerStore.setState({ props, loaded });
  });
};

/** The capsule, or `null` while there is none. */
const capsule = () => document.querySelector('[data-waiting]');

describe('selectWaiting', () => {
  test('loading: mpv is not idle and the file is not loaded', () => {
    expect(selectWaiting({ props: { 'idle-active': false }, loaded: false })).toBe('loading');
  });

  test('buffering: mpv waits for the network', () => {
    expect(
      selectWaiting({ props: { 'idle-active': false, 'paused-for-cache': true }, loaded: true }),
    ).toBe('buffering');
    // Before mpv has said whether it is idle, a wait is still a wait.
    expect(selectWaiting({ props: { 'paused-for-cache': true }, loaded: true })).toBe('buffering');
  });

  test('loading is what a file that has not loaded yet waits for, also when the network holds it', () => {
    expect(
      selectWaiting({ props: { 'idle-active': false, 'paused-for-cache': true }, loaded: false }),
    ).toBe('loading');
  });

  test('nothing: a file that plays, an idle player, a player that has not said', () => {
    expect(selectWaiting({ props: { 'idle-active': false, 'paused-for-cache': false }, loaded: true })).toBeNull();
    expect(selectWaiting({ props: { 'idle-active': true }, loaded: false })).toBeNull();
    expect(selectWaiting({ props: {}, loaded: false })).toBeNull();
    // A wait that mpv left behind when the file went.
    expect(selectWaiting({ props: { 'idle-active': true, 'paused-for-cache': true }, loaded: false })).toBeNull();
  });
});

describe('loadingName', () => {
  test('is mpv\'s title, without the prefix of a long path', () => {
    expect(loadingName({ 'media-title': 'Duna' })).toBe('Duna');
    expect(loadingName({ 'media-title': '\\\\?\\C:\\Videa\\a.mkv' })).toBe('C:\\Videa\\a.mkv');
  });

  test('is the entry of the playlist while mpv has no title: the file, or the host of a link', () => {
    expect(loadingName({ playlist: [{ filename: 'C:\\Videa\\a.mkv', current: true }] })).toBe('a.mkv');
    expect(loadingName({ 'media-title': '', playlist: [{ filename: 'https://example.com/x?y=1', current: true }] })).toBe(
      'example.com',
    );
    expect(loadingName({})).toBe('');
  });

  test('is the host of a link while mpv\'s title is the tail of its address, which it answers at once', () => {
    const playlist = [{ filename: 'https://example.com/watch?v=abc', current: true }];
    expect(loadingName({ 'media-title': 'watch?v=abc', playlist })).toBe('example.com');
    // Once the demuxer has a title, that is the name.
    expect(loadingName({ 'media-title': 'A talk about glass', playlist })).toBe('A talk about glass');
  });
});

test('loading title shows until file-loaded', () => {
  state({ 'idle-active': false, 'media-title': 'Duna: Část druhá.mkv' });
  render(<LoadingTitle />);

  // Between the start of the file and `player:file-loaded`: its name and that it is loading.
  expect(screen.getByText('Duna: Část druhá.mkv')).toBeTruthy();
  expect(screen.getByText('Loading…')).toBeTruthy();
  expect(capsule()?.getAttribute('data-shown')).toBe('true');

  act(() => {
    usePlayerStore.getState().fileLoaded();
  });
  // It fades, and is taken away when it has.
  expect(capsule()?.getAttribute('data-shown')).toBe('false');
  advance(LOADING_FADE_MS);
  expect(capsule()).toBeNull();
  expect(screen.queryByText('Duna: Část druhá.mkv')).toBeNull();
});

test('it shows again for the next file of the playlist, whose end cleared loaded', () => {
  state({ 'idle-active': false, 'media-title': 'První' }, true);
  render(<LoadingTitle />);
  expect(capsule()).toBeNull();

  act(() => {
    usePlayerStore.getState().endFile({ reason: 'error', error: 'loading failed', file: null, continues: false });
    usePlayerStore.getState().applyChanges({ 'media-title': 'Druhý' });
  });

  expect(screen.getByText('Druhý')).toBeTruthy();
  expect(screen.getByText('Loading…')).toBeTruthy();
});

test('it shows the host of a link until mpv knows its title, and none of the credentials', () => {
  state({
    'idle-active': false,
    playlist: [{ filename: 'https://user:secret@example.com/watch?v=abc', current: true }],
  });
  render(<LoadingTitle />);

  expect(screen.getByText('example.com')).toBeTruthy();
  expect(document.body.textContent).not.toContain('secret');

  act(() => {
    usePlayerStore.getState().applyChanges({ 'media-title': 'A talk about glass' });
  });
  expect(screen.getByText('A talk about glass')).toBeTruthy();
  expect(screen.queryByText('example.com')).toBeNull();
});

test('a link shows its host while mpv\'s title is only the tail of its address', () => {
  state({
    'idle-active': false,
    'media-title': 'watch?v=abc',
    playlist: [{ filename: 'https://example.com/watch?v=abc', current: true }],
  });
  render(<LoadingTitle />);

  expect(screen.getByText('example.com')).toBeTruthy();
  expect(screen.queryByText('watch?v=abc')).toBeNull();
});

test('a long path shows without its \\\\?\\ prefix', () => {
  state({ 'idle-active': false, 'media-title': '\\\\?\\C:\\Videa\\a.mkv' });
  render(<LoadingTitle />);

  expect(screen.getByText('C:\\Videa\\a.mkv')).toBeTruthy();
});

test('with no name at all it is the ring and the word', () => {
  state({ 'idle-active': false });
  render(<LoadingTitle />);

  expect(screen.getByText('Loading…')).toBeTruthy();
  expect(capsule()?.querySelector('[title]')).toBeNull();
});

test('a stream that waits for the network shows it while the video is loaded', () => {
  state({ 'idle-active': false, 'media-title': 'Stream', 'paused-for-cache': true }, true);
  render(<LoadingTitle />);

  expect(screen.getByText('Stream')).toBeTruthy();
  expect(screen.getByText('Buffering…')).toBeTruthy();
  expect(screen.queryByText('Loading…')).toBeNull();

  act(() => {
    usePlayerStore.getState().applyChanges({ 'paused-for-cache': false });
  });
  expect(capsule()?.getAttribute('data-shown')).toBe('false');
  // It says what it said while it fades.
  expect(screen.getByText('Buffering…')).toBeTruthy();
  advance(LOADING_FADE_MS);
  expect(capsule()).toBeNull();
});

test('nothing shows while a file plays or the player is idle', () => {
  state({ 'idle-active': false, 'media-title': 'Duna', 'paused-for-cache': false }, true);
  const { unmount } = render(<LoadingTitle />);
  expect(capsule()).toBeNull();
  unmount();

  state({ 'idle-active': true }, false);
  render(<LoadingTitle />);
  expect(capsule()).toBeNull();
});

test('it is a polite live region that is in the page before it has anything to say', () => {
  render(<LoadingTitle />);
  const region = screen.getByRole('status');
  expect(region.getAttribute('aria-live')).toBe('polite');
  expect(region.textContent).toBe('');

  state({ 'idle-active': false, 'media-title': 'Duna' });
  // The same element, now with the text in it.
  expect(screen.getByRole('status')).toBe(region);
  expect(region.textContent).toContain('Duna');
  expect(region.textContent).toContain('Loading…');
});

test('the texts follow the language', () => {
  state({ 'idle-active': false, 'media-title': 'Duna' });
  render(<LoadingTitle />);

  act(() => {
    setLanguage('cs');
  });

  expect(screen.getByText('Načítání…')).toBeTruthy();
});
