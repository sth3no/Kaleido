import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, expect, test, vi } from 'vitest';

import App from './App';
import { initI18n } from './i18n';
import { usePluginsStore } from './plugins/pluginsStore';
import { useNoticeStore } from './state/noticeStore';
import { usePlayerStore } from './state/playerStore';
import { useUiStore } from './state/uiStore';

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

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  useNoticeStore.setState(useNoticeStore.getInitialState(), true);
  usePluginsStore.setState(usePluginsStore.getInitialState(), true);
  // Rust says nothing is open, and the glass is on.
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(((command: string) => {
    if (command === 'system_ui_ready') return Promise.resolve({ 'idle-active': true, pause: true });
    if (command === 'glass_state') return Promise.resolve({ enabled: true, reason: null });
    return Promise.resolve(null);
  }) as unknown as typeof invoke);
});

test('with nothing open the app shows the start page with the sidebar and the window buttons', async () => {
  render(<App />);

  // The bridge got the player's state from Rust.
  await waitFor(() => {
    expect(usePlayerStore.getState().props['idle-active']).toBe(true);
  });
  expect(screen.getByRole('main').getAttribute('data-view')).toBe('home');
  const nav = within(screen.getByRole('navigation', { name: 'Pages' }));
  expect(nav.getByRole('button', { name: 'Player' }).getAttribute('aria-current')).toBe('page');
  expect(nav.getByRole('button', { name: 'Settings' })).toBeTruthy();
  for (const name of ['Minimize', 'Maximize', 'Close']) {
    expect(screen.getByRole('button', { name })).toBeTruthy();
  }
  // No video: no title island.
  expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();

  // The settings are a click away.
  fireEvent.click(nav.getByRole('button', { name: 'Settings' }));
  expect(useUiStore.getState().page).toBe('settings');
  expect(screen.getByRole('main').getAttribute('data-view')).toBe('settings');
  // The settings page is what the shell shows there: its title and the first section.
  expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
  expect(screen.getByRole('heading', { level: 2, name: 'Playback' })).toBeTruthy();
});

test('My plugins is a page of the app, between the player and the settings', async () => {
  render(<App />);
  await waitFor(() => {
    expect(usePlayerStore.getState().props['idle-active']).toBe(true);
  });
  const nav = within(screen.getByRole('navigation', { name: 'Pages' }));
  expect(nav.getAllByRole('button').map((item) => item.textContent)).toEqual([
    'Player',
    'My plugins',
    'Settings',
  ]);

  fireEvent.click(nav.getByRole('button', { name: 'My plugins' }));

  expect(useUiStore.getState().page).toBe('plugins');
  expect(screen.getByRole('main').getAttribute('data-view')).toBe('plugins');
  expect(screen.getByRole('heading', { level: 1, name: 'My plugins' })).toBeTruthy();
  // The page asked Rust for the plugins.
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'plugins_list')).toBe(true);
});

/** What a drag carries; jsdom has no DataTransfer, and the hook reads these members only. */
function dragged(data: Record<string, string>) {
  return {
    types: Object.keys(data),
    files: [],
    getData: (type: string) => data[type] ?? '',
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

test('the whole window takes a dropped link, and the start screen lights its zone while one is dragged over', async () => {
  render(<App />);
  await waitFor(() => {
    expect(usePlayerStore.getState().props['idle-active']).toBe(true);
  });
  const zone = screen.getByRole('region', { name: 'Drop a video here' });
  expect(zone.getAttribute('data-dragging')).toBe('false');

  fireEvent.dragEnter(window, { dataTransfer: dragged({ 'text/uri-list': 'https://example.com/v' }) });
  expect(zone.getAttribute('data-dragging')).toBe('true');

  fireEvent.drop(window, { dataTransfer: dragged({ 'text/uri-list': 'https://example.com/v' }) });
  expect(zone.getAttribute('data-dragging')).toBe('false');
  // Through Rust's open queue, as a pasted link (Ruling R54).
  expect(invoke).toHaveBeenCalledWith('system_open_text', { text: 'https://example.com/v' });
});

test('a drop on the settings page is cancelled as well, and a link dropped there opens', async () => {
  render(<App />);
  await waitFor(() => {
    expect(usePlayerStore.getState().props['idle-active']).toBe(true);
  });
  act(() => {
    useUiStore.getState().setPage('settings');
  });

  // Nothing Kaleido opens: the drop is still cancelled, so that WebView2 does not go to it.
  const notCancelled = fireEvent.drop(window, { dataTransfer: dragged({ 'text/html': '<p>x</p>' }) });
  expect(notCancelled).toBe(false);

  fireEvent.drop(window, { dataTransfer: dragged({ 'text/plain': 'https://example.com/v' }) });
  // Rust plays it and says so (`system:open-request`), which shows the player (state/bridge.ts).
  expect(invoke).toHaveBeenCalledWith('system_open_text', { text: 'https://example.com/v' });
});

test('a file that fails to open leaves its card on the start screen, where mpv is idle again', async () => {
  render(<App />);
  await waitFor(() => {
    expect(usePlayerStore.getState().props['idle-active']).toBe(true);
  });

  act(() => {
    usePlayerStore.getState().endFile({
      reason: 'error',
      error: 'loading failed',
      file: 'C:\\Videa\\poškozený.mkv',
      continues: false,
      streamError: null,
    });
  });

  // The player page is not there for it: the card is the shell's, over every page.
  expect(screen.getByRole('main').getAttribute('data-view')).toBe('home');
  expect(screen.getByRole('alert').textContent).toContain('could not be opened');
  expect(screen.getByText('Cannot play poškozený.mkv')).toBeTruthy();
  expect(screen.getByRole('list', { name: 'Notifications' })).toBeTruthy();

  // Nothing is left to play: the way on is the open dialog, which the card has.
  const card = screen.getByRole('list', { name: 'Notifications' });
  fireEvent.click(within(card).getByRole('button', { name: 'Open file' }));
  expect(invoke).toHaveBeenCalledWith('system_open_dialog', { purpose: 'media' });
  expect(screen.queryByRole('list', { name: 'Notifications' })).toBeNull();
});

test('a dropped link that Rust refuses says so on a card', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.mocked(invoke).mockImplementation(((command: string) => {
    if (command === 'system_ui_ready') return Promise.resolve({ 'idle-active': true, pause: true });
    if (command === 'glass_state') return Promise.resolve({ enabled: true, reason: null });
    if (command === 'system_open_text') {
      return Promise.reject({ source: 'https://example.com/v', kind: 'invalid' });
    }
    return Promise.resolve(null);
  }) as unknown as typeof invoke);
  render(<App />);
  await waitFor(() => {
    expect(usePlayerStore.getState().props['idle-active']).toBe(true);
  });

  fireEvent.drop(window, { dataTransfer: dragged({ 'text/uri-list': 'https://example.com/v' }) });

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('dropped link could not be opened');
  expect(screen.getByRole('main').getAttribute('data-view')).toBe('home');
  warn.mockRestore();
});
