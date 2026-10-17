import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, expect, test, vi } from 'vitest';

import { initI18n } from '../i18n';
import { usePlayerStore } from '../state/playerStore';
import TitleIsland from './TitleIsland';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
});

const island = (onMenu = vi.fn()) =>
  render(<TitleIsland sidebarId="sidebar" sidebarOpen={false} onMenu={onMenu} />);

test('title island shows the media title and video badge', () => {
  usePlayerStore.setState({
    loaded: true,
    props: {
      'idle-active': false,
      'media-title': 'Duna: Část druhá',
      'video-params': { w: 3840, h: 2160, gamma: 'pq' },
    },
  });
  island();

  expect(screen.getByText('Duna: Část druhá')).toBeTruthy();
  expect(screen.getByText('4K HDR')).toBeTruthy();

  // Another file: its title and its badge, and no badge without video.
  act(() => {
    usePlayerStore.getState().applyChanges({
      'media-title': 'koncert.flac',
      'video-params': null,
    });
  });
  expect(screen.getByText('koncert.flac')).toBeTruthy();
  expect(screen.queryByText('4K HDR')).toBeNull();
});

test('without a media title the island shows the file name', () => {
  usePlayerStore.setState({
    loaded: true,
    props: {
      'idle-active': false,
      playlist: [{ filename: 'C:\\Videa\\Žluťoučký kůň.mkv', current: true }],
      'video-params': { h: 1080 },
    },
  });
  island();

  expect(screen.getByText('Žluťoučký kůň.mkv')).toBeTruthy();
  expect(screen.getByText('1080p')).toBeTruthy();
});

test('the hamburger says whether the pointer or the keyboard pressed it', () => {
  const onMenu = vi.fn();
  island(onMenu);
  const menu = screen.getByRole('button', { name: 'Menu' });
  expect(menu.getAttribute('aria-controls')).toBe('sidebar');
  expect(menu.getAttribute('aria-expanded')).toBe('false');

  // A mouse click has a click count; Enter and Space make a click without one.
  fireEvent.click(menu, { detail: 1 });
  fireEvent.click(menu, { detail: 0 });
  expect(onMenu.mock.calls).toEqual([[false], [true]]);
});
