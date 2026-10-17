import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, expect, test, vi } from 'vitest';

import App from './App';
import { initI18n } from './i18n';
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
});
