import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

import { initI18n } from '../i18n';
import { usePlayerStore, type PlayerProps } from '../state/playerStore';
import { useUiStore } from '../state/uiStore';
import ControlsIsland from './ControlsIsland';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const TWO_FILES = [
  { filename: 'C:\\Videa\\a.mkv', current: true },
  { filename: 'C:\\Videa\\b.mkv' },
];

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

function open(props: PlayerProps = {}) {
  usePlayerStore.setState({
    loaded: true,
    props: { 'idle-active': false, pause: false, 'time-pos': 10, duration: 600, ...props },
  });
}

/** The commands sent to the player, each call. */
const allCommands = (): Record<string, unknown>[] =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([name]) => name === 'player_command')
    .map(([, args]) => (args as { cmd: Record<string, unknown> }).cmd);

/** Those the buttons sent: not the subtitle margin the island sets for itself. */
const commands = (): Record<string, unknown>[] =>
  allCommands().filter((cmd) => cmd['type'] !== 'setSubMargin');

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

test('prev and next are disabled without a playlist', () => {
  open();
  render(<ControlsIsland />);
  expect(button('Previous').disabled).toBe(true);
  expect(button('Next').disabled).toBe(true);

  // A disabled button does nothing.
  fireEvent.click(button('Previous'));
  fireEvent.click(button('Next'));
  expect(commands()).toEqual([]);

  // One file is no playlist to go through either.
  act(() => {
    usePlayerStore.getState().applyChanges({ playlist: [{ filename: 'C:\\Videa\\a.mkv', current: true }] });
  });
  expect(button('Previous').disabled).toBe(true);
  expect(button('Next').disabled).toBe(true);
});

test('prev and next work with a playlist', () => {
  open({ playlist: TWO_FILES });
  render(<ControlsIsland />);
  expect(button('Previous').disabled).toBe(false);
  expect(button('Next').disabled).toBe(false);

  fireEvent.click(button('Next'));
  fireEvent.click(button('Previous'));
  expect(commands()).toEqual([{ type: 'playlistNext' }, { type: 'playlistPrev' }]);
});

test('the play button is a pause button while the video plays', () => {
  open({ pause: false });
  render(<ControlsIsland />);
  fireEvent.click(button('Pause'));
  expect(commands()).toEqual([{ type: 'togglePause' }]);
  expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();

  act(() => {
    usePlayerStore.getState().applyChanges({ pause: true });
  });
  expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  fireEvent.click(button('Play'));
  expect(commands().at(-1)).toEqual({ type: 'togglePause' });
});

test('the fullscreen button asks mpv, which Rust follows, and never the window itself', () => {
  open({ fullscreen: false });
  render(<ControlsIsland />);
  fireEvent.click(button('Fullscreen'));
  expect(commands().filter((cmd) => cmd['type'] === 'setFullscreen')).toEqual([
    { type: 'setFullscreen', on: true },
  ]);

  // In fullscreen the same button leaves it.
  act(() => {
    usePlayerStore.getState().applyChanges({ fullscreen: true });
  });
  expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull();
  fireEvent.click(button('Exit fullscreen'));
  expect(commands().at(-1)).toEqual({ type: 'setFullscreen', on: false });
});

test('the subtitles button opens quick settings on the Subtitles tab, and closes it again', () => {
  open();
  useUiStore.getState().setQuickTab('audio');
  render(<ControlsIsland />);
  const subtitles = button('Subtitles');
  expect(subtitles.getAttribute('aria-expanded')).toBe('false');
  expect(subtitles.getAttribute('aria-haspopup')).toBe('dialog');

  fireEvent.click(subtitles);
  expect(useUiStore.getState().panel).toBe('quick-settings');
  expect(useUiStore.getState().quickTab).toBe('subtitles');
  expect(subtitles.getAttribute('aria-expanded')).toBe('true');

  fireEvent.click(subtitles);
  expect(useUiStore.getState().panel).toBeNull();

  // Quick settings are open on the Audio tab: the button brings the Subtitles tab, it does not close.
  act(() => {
    useUiStore.getState().setQuickTab('audio');
    useUiStore.getState().setPanel('quick-settings');
  });
  expect(subtitles.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(subtitles);
  expect(useUiStore.getState().panel).toBe('quick-settings');
  expect(useUiStore.getState().quickTab).toBe('subtitles');
});

test('the playlist button opens the playlist, and closes it again', () => {
  open({ playlist: TWO_FILES });
  render(<ControlsIsland />);
  const playlist = button('Playlist');

  fireEvent.click(playlist);
  expect(useUiStore.getState().panel).toBe('playlist');
  expect(playlist.getAttribute('aria-expanded')).toBe('true');

  fireEvent.click(playlist);
  expect(useUiStore.getState().panel).toBeNull();
});

test('the island is one group of controls, and an island for the autohide', () => {
  open();
  render(<ControlsIsland />);
  const island = screen.getByRole('group', { name: 'Playback controls' });
  expect(island.hasAttribute('data-island')).toBe(true);
  expect(island.getAttribute('data-hidden')).toBe('false');
  expect(island.hasAttribute('inert')).toBe(false);
  // The seekbar and the volume are both in it.
  expect(screen.getByRole('slider', { name: 'Seek' })).toBeTruthy();
  expect(screen.getByRole('slider', { name: 'Volume' })).toBeTruthy();
});

test('hidden, the island is out of the tab order and of reach', () => {
  open();
  const { rerender } = render(<ControlsIsland hidden />);
  const island = document.querySelector('[data-island]');
  expect(island?.getAttribute('data-hidden')).toBe('true');
  expect(island?.hasAttribute('inert')).toBe(true);

  rerender(<ControlsIsland hidden={false} />);
  expect(island?.getAttribute('data-hidden')).toBe('false');
  expect(island?.hasAttribute('inert')).toBe(false);
});

test('the subtitles are lifted above the island while it shows, and drop when it hides', () => {
  open();
  const margins = () =>
    allCommands()
      .filter((cmd) => cmd['type'] === 'setSubMargin')
      .map((cmd) => cmd['margin']);

  const { rerender, unmount } = render(<ControlsIsland />);
  const lifted = margins();
  expect(lifted).toHaveLength(1);
  expect(lifted[0]).toBeGreaterThan(0);

  rerender(<ControlsIsland hidden />);
  expect(margins()).toEqual([lifted[0], 0]);

  unmount();
  // Nothing more to say: the margin is 0 already.
  expect(margins()).toEqual([lifted[0], 0]);
});

test('the context menu of the page does not open on the controls', () => {
  open();
  render(<ControlsIsland />);
  const notPrevented = fireEvent.contextMenu(button('Pause'));
  expect(notPrevented).toBe(false);
});

test('back from the mini player with the keyboard, the focus lands on play and pause', () => {
  open();
  // "Back to player" pressed with Enter asks for it (mini/MiniPlayer.tsx); the island is hidden
  // (inert) at first, and takes it when it shows.
  useUiStore.getState().setFocusRequest('play');
  const { rerender } = render(<ControlsIsland hidden />);
  expect(document.activeElement).toBe(document.body);
  expect(useUiStore.getState().focusRequest).toBe('play');

  rerender(<ControlsIsland hidden={false} />);
  expect(document.activeElement).toBe(button('Pause'));
  expect(useUiStore.getState().focusRequest).toBeNull();
});

test('a click with the pointer gives the focus back, so that Space goes to mpv again', () => {
  open();
  render(<ControlsIsland />);
  const pause = button('Pause');
  pause.focus();
  expect(document.activeElement).toBe(pause);
  fireEvent.pointerUp(pause);
  expect(document.activeElement).not.toBe(pause);
});
