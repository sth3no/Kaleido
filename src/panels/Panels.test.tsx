import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

import { initI18n } from '../i18n';
import { attachVideoInput } from '../input/forward';
import ControlsIsland from '../player/ControlsIsland';
import { usePlayerStore, type PlayerProps } from '../state/playerStore';
import { useUiStore } from '../state/uiStore';
import { realClick } from './pointerSequence';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  // The seekbar's clock and the glass measure on animation frames: none run here.
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A file with two subtitle tracks and a playlist of two files plays. */
function open(props: PlayerProps = {}) {
  usePlayerStore.setState({
    loaded: true,
    props: {
      'idle-active': false,
      pause: false,
      'time-pos': 10,
      duration: 600,
      'track-list': [
        { id: 1, type: 'sub', lang: 'cs' },
        { id: 2, type: 'sub', lang: 'en' },
      ],
      sid: 1,
      playlist: [
        { filename: 'C:\\Videa\\a.mkv', current: true },
        { filename: 'C:\\Videa\\b.mkv' },
      ],
      ...props,
    },
  });
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

/** What was passed on to mpv. */
const forwarded = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'player_input');

/** The keys that were passed on to mpv as pressed. */
const keysSent = (): (string | undefined)[] =>
  forwarded()
    .map(([, args]) => (args as { event: { type: string; key?: string } }).event)
    .filter((event) => event.type === 'keyDown')
    .map((event) => event.key);

test.each([
  ['Subtitles', 'Quick settings', 'quick-settings'],
  ['Playlist', 'Playlist', 'playlist'],
] as const)(
  'escape closes the panel and returns focus to its button (%s)',
  (buttonName, dialogName, panel) => {
    const detach = attachVideoInput(document.createElement('div'));
    try {
      open();
      render(<ControlsIsland />);
      const opener = button(buttonName);
      act(() => {
        opener.focus();
      });
      expect(opener.getAttribute('aria-expanded')).toBe('false');

      fireEvent.click(opener);
      const dialog = screen.getByRole('dialog', { name: dialogName });
      expect(useUiStore.getState().panel).toBe(panel);
      expect(opener.getAttribute('aria-expanded')).toBe('true');
      // The focus went into the panel.
      expect(dialog.contains(document.activeElement)).toBe(true);

      const passedOn = fireEvent.keyDown(document.activeElement as Element, {
        key: 'Escape',
        code: 'Escape',
      });

      // Handled: mpv does not get Esc (it would leave fullscreen).
      expect(passedOn).toBe(false);
      expect(forwarded()).toEqual([]);
      expect(useUiStore.getState().panel).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(opener.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(opener);
    } finally {
      detach();
    }
  },
);

test('a click on its button closes the panel and leaves nothing focused, so Space goes to mpv', () => {
  const detach = attachVideoInput(document.createElement('div'));
  try {
    open();
    render(<ControlsIsland />);
    const playlist = button('Playlist');
    // The mouse, as the browser delivers it: pointerdown, mousedown and its focus, pointerup, click.
    realClick(playlist);
    expect(screen.getByRole('dialog', { name: 'Playlist' }).contains(document.activeElement)).toBe(true);

    realClick(playlist);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useUiStore.getState().panel).toBeNull();
    // Not the button: a button that held the focus would keep Space from mpv (R44).
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
    expect(keysSent()).toEqual(['SPACE']);
  } finally {
    detach();
  }
});

test('a click on the video closes the panel and leaves nothing focused, so Space goes to mpv', () => {
  open();
  render(
    <>
      <div data-video-layer data-testid="video" />
      <ControlsIsland />
    </>,
  );
  const video = screen.getByTestId('video');
  const detach = attachVideoInput(video);
  try {
    realClick(button('Subtitles'));
    expect(screen.queryByRole('dialog', { name: 'Quick settings' })).not.toBeNull();

    realClick(video);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useUiStore.getState().panel).toBeNull();
    // The click closed the panel and went no further: mpv got no button.
    expect(
      forwarded().filter(([, args]) => (args as { event: { type: string } }).event.type.startsWith('button')),
    ).toEqual([]);
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
    expect(keysSent()).toEqual(['SPACE']);
  } finally {
    detach();
  }
});

test('one panel at a time: the other button takes the panel and the focus', () => {
  open();
  render(<ControlsIsland />);
  fireEvent.click(button('Subtitles'));
  expect(screen.getByRole('dialog', { name: 'Quick settings' })).toBeTruthy();

  fireEvent.click(button('Playlist'));
  expect(screen.queryByRole('dialog', { name: 'Quick settings' })).toBeNull();
  const playlist = screen.getByRole('dialog', { name: 'Playlist' });
  expect(useUiStore.getState().panel).toBe('playlist');
  expect(playlist.contains(document.activeElement)).toBe(true);
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
});

test('the Subtitles button brings the Subtitles tab to quick settings open on Audio, and keeps them open', () => {
  open();
  useUiStore.setState({ panel: 'quick-settings', quickTab: 'audio' });
  render(<ControlsIsland />);
  const subtitles = button('Subtitles');
  expect(screen.getByRole('tab', { name: 'Audio' }).getAttribute('aria-selected')).toBe('true');

  // The press on the button does not close the panel; its click decides.
  fireEvent.pointerDown(subtitles, { button: 0, pointerId: 1 });
  expect(screen.queryByRole('dialog', { name: 'Quick settings' })).not.toBeNull();
  fireEvent.click(subtitles);

  expect(useUiStore.getState().panel).toBe('quick-settings');
  expect(useUiStore.getState().quickTab).toBe('subtitles');
  expect(screen.getByRole('tab', { name: 'Subtitles' }).getAttribute('aria-selected')).toBe('true');
});

test('a panel opened on a track list shows what the file has', () => {
  open();
  render(<ControlsIsland />);
  fireEvent.click(button('Subtitles'));
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
    'Czech',
    'English',
    'Off',
  ]);

  fireEvent.click(screen.getByRole('option', { name: 'English' }));
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === 'player_command')
      .map(([, args]) => (args as { cmd: Record<string, unknown> }).cmd)
      .filter((cmd) => cmd['type'] === 'selectTrack'),
  ).toEqual([{ type: 'selectTrack', kind: 'sub', id: 2 }]);
});

test('the panel goes with the island: it is closed when the island is taken away', () => {
  open();
  const { unmount } = render(<ControlsIsland />);
  fireEvent.click(button('Playlist'));
  expect(useUiStore.getState().panel).toBe('playlist');
  expect(screen.queryByRole('dialog')).not.toBeNull();

  unmount();

  expect(useUiStore.getState().panel).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a press on another control closes the panel', () => {
  open();
  render(<ControlsIsland />);
  fireEvent.click(button('Subtitles'));
  expect(useUiStore.getState().panel).toBe('quick-settings');

  fireEvent.pointerDown(button('Pause'), { button: 0, pointerId: 1 });

  expect(useUiStore.getState().panel).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});
