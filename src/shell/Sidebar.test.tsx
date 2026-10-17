import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

import { initI18n } from '../i18n';
import { usePlayerStore } from '../state/playerStore';
import { useUiStore } from '../state/uiStore';
import AppShell from './AppShell';
import { EDGE_PX } from './Sidebar';

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

/** A file that plays. */
const PLAYING = {
  'idle-active': false,
  pause: false,
  'time-pos': 12,
  duration: 600,
  'media-title': 'Duna: Část druhá',
};

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

afterEach(() => {
  vi.restoreAllMocks();
});

const playing = () => {
  usePlayerStore.setState({ loaded: true, props: PLAYING });
};

const idle = () => {
  usePlayerStore.setState({ loaded: false, props: { 'idle-active': true } });
};

const shell = () =>
  render(<AppShell home={<p>Start</p>} player={<p>Video</p>} settings={<p>Options</p>} />);

/** The sidebar, if it can be seen (and reached) now. */
const sidebar = () => screen.queryByRole('navigation', { name: 'Pages' });

/** Where the focus is. */
function focused(): Element {
  const element = document.activeElement;
  if (!element) throw new Error('nothing has the focus');
  return element;
}

/** What was passed on to mpv. */
const forwarded = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'player_input');

test('sidebar is hidden while playing and opens from the hamburger', () => {
  playing();
  shell();
  expect(sidebar()).toBeNull();

  // A click with the pointer (a click count of 1).
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }), { detail: 1 });

  const nav = sidebar();
  expect(nav).not.toBeNull();
  expect(useUiStore.getState().sidebarOpen).toBe(true);
  expect(screen.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded')).toBe('true');
  const items = within(nav as HTMLElement);
  expect(items.getByRole('button', { name: 'Player' }).getAttribute('aria-current')).toBe('page');
  expect(items.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBeNull();

  // ☰ again closes it.
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }), { detail: 1 });
  expect(sidebar()).toBeNull();
});

test('sidebar is shown beside the page without video', () => {
  idle();
  shell();
  expect(screen.getByText('Start')).toBeTruthy();
  const nav = sidebar();
  expect(nav).not.toBeNull();
  expect(useUiStore.getState().sidebarOpen).toBe(false);
  // Nothing to open: there is no ☰.
  expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
});

test('sidebar opens when the pointer reaches the left edge', () => {
  playing();
  shell();
  // The sidebar's panel is 200 px wide at 16 px from the edge.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const box = this.tagName === 'NAV' ? { left: 16, top: 16, width: 200, height: 600 } : { left: 0, top: 0, width: 0, height: 0 };
    return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height } as DOMRect;
  });

  fireEvent.pointerMove(window, { clientX: 40, clientY: 300 });
  expect(sidebar()).toBeNull();
  fireEvent.pointerMove(window, { clientX: EDGE_PX, clientY: 300 });
  expect(sidebar()).not.toBeNull();

  // It only peeks: over it, it stays; once the pointer has moved on past it, it goes.
  fireEvent.pointerMove(window, { clientX: 120, clientY: 300 });
  expect(sidebar()).not.toBeNull();
  fireEvent.pointerMove(window, { clientX: 600, clientY: 300 });
  expect(sidebar()).toBeNull();
});

test('escape closes the sidebar', () => {
  playing();
  shell();
  const menu = screen.getByRole('button', { name: 'Menu' });
  menu.focus();
  // Enter on ☰: a click without a click count. The focus goes to the current page's item.
  fireEvent.click(menu, { detail: 0 });
  expect(sidebar()).not.toBeNull();
  expect(focused()).toBe(screen.getByRole('button', { name: 'Player' }));

  const passedOn = fireEvent.keyDown(focused(), { key: 'Escape', code: 'Escape' });

  // Handled: mpv does not get Esc (it would leave fullscreen).
  expect(passedOn).toBe(false);
  expect(forwarded()).toEqual([]);
  expect(useUiStore.getState().sidebarOpen).toBe(false);
  expect(sidebar()).toBeNull();
  // The focus is back on ☰.
  expect(focused()).toBe(menu);
});

test('arrow keys move between the sidebar items and do not reach mpv', () => {
  idle();
  shell();
  const player = screen.getByRole('button', { name: 'Player' });
  const settings = screen.getByRole('button', { name: 'Settings' });
  // The current page is the one Tab reaches.
  expect(player.tabIndex).toBe(0);
  expect(settings.tabIndex).toBe(-1);
  player.focus();

  expect(fireEvent.keyDown(focused(), { key: 'ArrowDown', code: 'ArrowDown' })).toBe(false);
  expect(focused()).toBe(settings);
  fireEvent.keyDown(focused(), { key: 'ArrowDown', code: 'ArrowDown' });
  expect(focused()).toBe(player);
  fireEvent.keyDown(focused(), { key: 'End', code: 'End' });
  expect(focused()).toBe(settings);
  fireEvent.keyDown(focused(), { key: 'ArrowUp', code: 'ArrowUp' });
  expect(focused()).toBe(player);
  expect(forwarded()).toEqual([]);

  // Choosing an item opens its page.
  fireEvent.click(settings);
  expect(useUiStore.getState().page).toBe('settings');
  expect(screen.getByText('Options')).toBeTruthy();
});
