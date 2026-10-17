import { invoke } from '@tauri-apps/api/core';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n } from '../i18n';
import { usePlayerStore } from '../state/playerStore';
import { useUiStore } from '../state/uiStore';
import AppShell, { selectView } from './AppShell';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
const appWindow = vi.hoisted(() => ({
  minimize: vi.fn(() => Promise.resolve()),
  toggleMaximize: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  isMaximized: vi.fn(() => Promise.resolve(false)),
  onResized: vi.fn(() => Promise.resolve(() => undefined)),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => appWindow }));

const PLAYING = { 'idle-active': false, pause: false, 'time-pos': 12, duration: 600, 'media-title': 'Duna' };

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  // The bridge asks Rust for the state; the answers never come, so the tests' state stays.
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(((command: string) =>
    command === 'system_ui_ready' || command === 'glass_state'
      ? new Promise(() => undefined)
      : Promise.resolve(null)) as unknown as typeof invoke);
});

const shell = () =>
  render(<AppShell home={<p>Start</p>} player={<p>Video</p>} settings={<p>Options</p>} />);

describe('selectView', () => {
  test('the settings while the user is there, whatever plays', () => {
    expect(selectView('settings', { props: PLAYING, loaded: true })).toBe('settings');
    expect(selectView('settings', { props: {}, loaded: false })).toBe('settings');
  });

  test('the player while a file is loaded or loading', () => {
    expect(selectView('player', { props: PLAYING, loaded: true })).toBe('player');
    // Loading: mpv is no longer idle, the file is not loaded yet.
    expect(selectView('player', { props: { 'idle-active': false }, loaded: false })).toBe('player');
  });

  test('the start screen when nothing is open, and before mpv has said', () => {
    expect(selectView('player', { props: { 'idle-active': true }, loaded: false })).toBe('home');
    // Before the first snapshot: no flash of the player at start; nor for a value mpv has not got.
    expect(selectView('player', { props: {}, loaded: false })).toBe('home');
    expect(selectView('player', { props: { 'idle-active': null }, loaded: false })).toBe('home');
  });
});

test('the shell shows the page for what is open', () => {
  shell();
  expect(screen.getByText('Start')).toBeTruthy();
  expect(screen.queryByText('Video')).toBeNull();

  act(() => {
    usePlayerStore.setState({ loaded: true, props: PLAYING });
  });
  expect(screen.getByText('Video')).toBeTruthy();
  // Over the video: the title island with ☰, the window buttons, and the page lets the pointer
  // through to the video layer.
  expect(screen.getByRole('button', { name: 'Menu' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  expect(screen.getByRole('main').getAttribute('data-view')).toBe('player');

  act(() => {
    useUiStore.getState().setPage('settings');
  });
  expect(screen.getByText('Options')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
});

test('the page is transparent only while a video is shown', () => {
  const shown = () => document.documentElement.hasAttribute('data-video');
  shell();
  expect(shown()).toBe(false);

  // Loading: still opaque (spec 5.1), the file is not loaded yet.
  act(() => {
    usePlayerStore.setState({ loaded: false, props: { 'idle-active': false } });
  });
  expect(shown()).toBe(false);
  act(() => {
    usePlayerStore.setState({ loaded: true, props: PLAYING });
  });
  expect(shown()).toBe(true);
  // The settings page (the mini player comes with Task 21) paints its own background.
  act(() => {
    useUiStore.getState().setPage('settings');
  });
  expect(shown()).toBe(false);
});

test('the shell starts the bridge to Rust, once', async () => {
  const asked = (name: string) => vi.mocked(invoke).mock.calls.filter(([command]) => command === name);
  shell();
  // It listens first, then asks for the player's state and the glass.
  await waitFor(() => {
    expect(asked('system_ui_ready')).toHaveLength(1);
  });
  expect(asked('glass_state')).toHaveLength(1);
});

test('unmounting the shell leaves the page opaque again', () => {
  usePlayerStore.setState({ loaded: true, props: PLAYING });
  const { unmount } = shell();
  expect(document.documentElement.hasAttribute('data-video')).toBe(true);
  unmount();
  expect(document.documentElement.hasAttribute('data-video')).toBe(false);
});

test('the islands of the shell fade and are out of reach while the player hides its controls', () => {
  usePlayerStore.setState({ loaded: true, props: PLAYING });
  shell();
  const islands = screen.getByRole('button', { name: 'Close' }).closest('[data-hidden]');
  expect(islands?.getAttribute('data-hidden')).toBe('false');
  expect(islands?.hasAttribute('inert')).toBe(false);

  // The player's autohide (player/useAutohide.ts) tells the shell through the store.
  act(() => {
    useUiStore.getState().setControlsHidden(true);
  });
  expect(islands?.getAttribute('data-hidden')).toBe('true');
  expect(islands?.hasAttribute('inert')).toBe(true);

  act(() => {
    useUiStore.getState().setControlsHidden(false);
  });
  expect(islands?.getAttribute('data-hidden')).toBe('false');
  expect(islands?.hasAttribute('inert')).toBe(false);
});

test('the islands of the shell are marked, so that the autohide knows the pointer is on one', () => {
  usePlayerStore.setState({ loaded: true, props: PLAYING });
  shell();
  const marked = (name: string) =>
    screen.getByRole('button', { name }).closest('[data-island]') !== null;
  expect(marked('Menu')).toBe(true);
  expect(marked('Close')).toBe(true);
});
