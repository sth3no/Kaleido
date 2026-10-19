import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

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
  // Windows' animations off: the mini player comes up in its place, with no frames running after
  // a test (its animation is surface/useSurfaceLayout.test.ts's).
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ media: query, matches: query === '(prefers-reduced-motion: reduce)' })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const shell = () =>
  render(
    <AppShell
      home={<p>Start</p>}
      player={<p>Video</p>}
      plugins={<p>Add-ons</p>}
      settings={<p>Options</p>}
    />,
  );

describe('selectView', () => {
  test('the settings while the user is there, whatever plays', () => {
    expect(selectView('settings', { props: PLAYING, loaded: true })).toBe('settings');
    expect(selectView('settings', { props: {}, loaded: false })).toBe('settings');
  });

  test('My plugins while the user is there, whatever plays', () => {
    expect(selectView('plugins', { props: PLAYING, loaded: true })).toBe('plugins');
    expect(selectView('plugins', { props: {}, loaded: false })).toBe('plugins');
    expect(selectView('plugins', { props: { 'idle-active': false }, loaded: false })).toBe('plugins');
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
  // On the settings page the video goes into the mini player, and the page layer paints the page
  // around it (Ruling R46): the root stays transparent.
  const pageLayer = () => screen.getByRole('main').closest('[data-page-layer]');
  act(() => {
    useUiStore.getState().setPage('settings');
  });
  expect(shown()).toBe(true);
  expect(pageLayer()?.getAttribute('data-mini')).toBe('true');
  // With nothing open the page is opaque, and the root paints it again.
  act(() => {
    usePlayerStore.setState({ loaded: false, props: { 'idle-active': true } });
  });
  expect(shown()).toBe(false);
  expect(pageLayer()?.getAttribute('data-mini')).toBe('false');
});

/** The kinds of the layouts the shell sent Rust, in order. */
const layoutKinds = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === 'surface_set_layout')
    .map(([, args]) => (args as { layout: { kind: string } }).layout.kind);

test('mpv’s window is hidden with no file, whole while one loads, and in the corner on the settings (Ruling R52)', async () => {
  const last = () => layoutKinds().at(-1);
  shell();
  // The start screen: mpv's idle window would be black under the page (Mica shows through it).
  await waitFor(() => {
    expect(layoutKinds()).toEqual(['hidden']);
  });

  // A file loads on the player page: the whole window, before its first frame.
  act(() => {
    usePlayerStore.setState({ loaded: false, props: { 'idle-active': false } });
  });
  await waitFor(() => {
    expect(last()).toBe('full');
  });

  // The settings while it plays: the mini player.
  act(() => {
    usePlayerStore.setState({ loaded: true, props: PLAYING });
    useUiStore.getState().setPage('settings');
  });
  await waitFor(() => {
    expect(last()).toBe('mini');
  });

  // Stopped there: hidden again, and the settings are the settings.
  act(() => {
    usePlayerStore.setState({ loaded: false, props: { 'idle-active': true } });
  });
  await waitFor(() => {
    expect(last()).toBe('hidden');
  });
});

test('My plugins is a page like the settings: docked, and the video plays in the mini player', async () => {
  usePlayerStore.setState({ loaded: true, props: PLAYING });
  shell();
  act(() => {
    useUiStore.getState().setPage('plugins');
  });

  expect(screen.getByRole('main').getAttribute('data-view')).toBe('plugins');
  expect(screen.getByText('Add-ons')).toBeTruthy();
  expect(screen.queryByText('Video')).toBeNull();
  // No video of its own: no title island with its ☰, the sidebar is docked.
  expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
  expect(screen.getByRole('navigation', { name: 'Pages' }).getAttribute('data-mode')).toBe('docked');
  await waitFor(() => {
    expect(layoutKinds().at(-1)).toBe('mini');
  });
  expect(screen.getByRole('main').closest('[data-page-layer]')?.getAttribute('data-mini')).toBe('true');
});

test('a file of the first launch’s command line: hidden until the UI is ready, then the whole window as it loads (Ruling R56)', async () => {
  // Rust's open queue holds the first launch's files until the UI is ready, plays them while it
  // answers `system_ui_ready`, and the answer already says mpv is not idle (it loads).
  let answer: (snapshot: Record<string, unknown>) => void = () => undefined;
  vi.mocked(invoke).mockImplementation(((command: string) => {
    if (command === 'system_ui_ready') {
      return new Promise((resolve) => {
        answer = resolve;
      });
    }
    if (command === 'glass_state') return new Promise(() => undefined);
    return Promise.resolve(null);
  }) as unknown as typeof invoke);
  shell();
  await waitFor(() => {
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'system_ui_ready')).toBe(true);
  });
  // Before the answer nothing is known to be open: mpv's window stays hidden.
  expect(layoutKinds()).toEqual(['hidden']);

  await act(async () => {
    answer({ 'idle-active': false, pause: false });
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(layoutKinds()).toEqual(['hidden', 'full']);
  });
  expect(screen.getByRole('main').getAttribute('data-view')).toBe('player');
});

test('the pointer reaches mpv only over the whole-window video of the player page (Ruling R52)', () => {
  const layer = () => document.querySelector<HTMLElement>('[data-video-layer]');
  const inputs = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'player_input');
  const spin = () => {
    const target = layer();
    if (target) fireEvent.wheel(target, { deltaY: 100, deltaMode: 0 });
  };
  shell();

  // The start screen: the layer shows through around the docked sidebar, and the wheel (the
  // volume, unseen) and a double click (fullscreen) there are not mpv's.
  expect(layer()?.getAttribute('data-pointer')).toBe('false');
  spin();
  expect(inputs()).toEqual([]);

  // A file loads on the player page: the video has the whole window, and the pointer is mpv's.
  act(() => {
    usePlayerStore.setState({ loaded: false, props: { 'idle-active': false } });
  });
  expect(layer()?.getAttribute('data-pointer')).toBe('true');
  spin();
  expect(inputs()).toHaveLength(1);
  expect(inputs()[0]?.[1]).toMatchObject({ event: { type: 'wheel' } });

  // The settings while it plays: the mini player takes the pointer itself.
  act(() => {
    usePlayerStore.setState({ loaded: true, props: PLAYING });
    useUiStore.getState().setPage('settings');
  });
  expect(layer()?.getAttribute('data-pointer')).toBe('false');
  spin();
  expect(inputs()).toHaveLength(1);
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

test('the notices are a layer of their own: on every view, and not faded with the islands', () => {
  usePlayerStore.setState({ loaded: true, props: PLAYING });
  render(
    <AppShell
      home={<p>Start</p>}
      player={<p>Video</p>}
      plugins={<p>Add-ons</p>}
      settings={<p>Options</p>}
      notices={<p>Card</p>}
    />,
  );
  act(() => {
    useUiStore.getState().setControlsHidden(true);
  });

  const card = screen.getByText('Card');
  expect(card.closest('[data-hidden]')).toBeNull();
  expect(card.closest('[inert]')).toBeNull();

  act(() => {
    useUiStore.getState().setPage('settings');
  });
  expect(screen.getByText('Card')).toBeTruthy();

  // A file that failed leaves the player for the start screen, and the card stays.
  act(() => {
    usePlayerStore.setState({ loaded: false, props: { 'idle-active': true } });
    useUiStore.getState().setPage('player');
  });
  expect(screen.getByRole('main').getAttribute('data-view')).toBe('home');
  expect(screen.getByText('Card')).toBeTruthy();
});

test('the islands of the shell are marked, so that the autohide knows the pointer is on one', () => {
  usePlayerStore.setState({ loaded: true, props: PLAYING });
  shell();
  const marked = (name: string) =>
    screen.getByRole('button', { name }).closest('[data-island]') !== null;
  expect(marked('Menu')).toBe(true);
  expect(marked('Close')).toBe(true);
});
