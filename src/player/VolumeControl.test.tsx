import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

import { initI18n } from '../i18n';
import { usePlayerStore, type PlayerProps } from '../state/playerStore';
import VolumeControl, { DEFAULT_VOLUME_MAX, volumeMaxOf } from './VolumeControl';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockClear();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
});

afterEach(() => {
  vi.useRealTimers();
});

const open = (props: PlayerProps) => {
  usePlayerStore.setState({ loaded: true, props: { 'idle-active': false, ...props } });
};

/** The commands sent to the player, each call. */
const commands = (type: string): Record<string, unknown>[] =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([name]) => name === 'player_command')
    .map(([, args]) => (args as { cmd: Record<string, unknown> }).cmd)
    .filter((cmd) => cmd['type'] === type);

const slider = () => screen.getByRole('slider', { name: 'Volume' }) as HTMLInputElement;

test('volume slider respects volume-max', () => {
  open({ volume: 100, 'volume-max': 150 });
  render(<VolumeControl />);

  expect(slider().min).toBe('0');
  expect(slider().max).toBe('150');
  expect(slider().value).toBe('100');

  // A value past the end is held to the end by the slider, and that is what mpv is asked for.
  fireEvent.change(slider(), { target: { value: '200' } });
  const volumes = commands('setVolume').map((cmd) => cmd['volume']);
  expect(volumes).toEqual([150]);
});

test('the slider goes to 130 unless mpv says another maximum', () => {
  open({ volume: 80 });
  const { unmount } = render(<VolumeControl />);
  expect(slider().max).toBe(String(DEFAULT_VOLUME_MAX));
  unmount();

  // A maximum that is no number or not above 0 is none.
  for (const value of [null, 0, -5, 'high', Number.NaN]) {
    expect(volumeMaxOf(value)).toBe(DEFAULT_VOLUME_MAX);
  }
  expect(volumeMaxOf(100)).toBe(100);
  expect(volumeMaxOf(300)).toBe(300);
});

test('the mark is where 100 % is, on the slider’s own scale', () => {
  open({ volume: 100, 'volume-max': 200 });
  render(<VolumeControl />);
  const scale = slider().parentElement as HTMLElement;
  expect(Number(scale.style.getPropertyValue('--mark'))).toBeCloseTo(0.5, 6);
  expect(scale.querySelector('span[aria-hidden]')).not.toBeNull();

  // A maximum of 100 or less has no 100 to mark.
  act(() => {
    usePlayerStore.getState().applyChanges({ 'volume-max': 100 });
  });
  expect(scale.querySelector('span[aria-hidden]')).toBeNull();
});

test('moving the slider sets the volume, and the slider keeps the value until mpv reports it', () => {
  open({ volume: 100 });
  render(<VolumeControl />);

  fireEvent.change(slider(), { target: { value: '60' } });
  expect(commands('setVolume')).toEqual([{ type: 'setVolume', volume: 60 }]);
  // mpv has not answered yet: the slider is where the user put it, not back at 100.
  expect(slider().value).toBe('60');
  expect(slider().getAttribute('aria-valuetext')).toBe('60%');

  act(() => {
    usePlayerStore.getState().applyChanges({ volume: 60 });
  });
  expect(slider().value).toBe('60');

  // mpv changes the volume itself (a key, the wheel): the slider follows.
  act(() => {
    usePlayerStore.getState().applyChanges({ volume: 85 });
  });
  expect(slider().value).toBe('85');
});

test('a volume mpv does not report is given up on after a moment', () => {
  open({ volume: 100, 'volume-max': 100 });
  render(<VolumeControl />);
  fireEvent.change(slider(), { target: { value: '40' } });
  expect(slider().value).toBe('40');

  // mpv never says 40 (it kept 100): the slider shows what mpv has.
  act(() => {
    vi.advanceTimersByTime(600);
  });
  expect(slider().value).toBe('100');
});

test('a fast drag sends the volume at most every 30 ms, and the last value is not lost', () => {
  open({ volume: 100 });
  render(<VolumeControl />);

  // Ten changes, 5 ms apart.
  for (let value = 90; value >= 81; value -= 1) {
    fireEvent.change(slider(), { target: { value: String(value) } });
    act(() => {
      vi.advanceTimersByTime(5);
    });
  }
  const during = commands('setVolume').map((cmd) => cmd['volume']);
  expect(during.length).toBeLessThanOrEqual(2);
  expect(during[0]).toBe(90);

  act(() => {
    vi.advanceTimersByTime(60);
  });
  expect(commands('setVolume').at(-1)).toEqual({ type: 'setVolume', volume: 81 });
});

test('the mute button mutes and unmutes', () => {
  open({ volume: 100, mute: false });
  render(<VolumeControl />);
  const mute = screen.getByRole('button', { name: 'Mute' });
  expect(mute.getAttribute('aria-pressed')).toBe('false');

  fireEvent.click(mute);
  expect(commands('setMute')).toEqual([{ type: 'setMute', muted: true }]);

  act(() => {
    usePlayerStore.getState().applyChanges({ mute: true });
  });
  expect(mute.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(mute);
  expect(commands('setMute').at(-1)).toEqual({ type: 'setMute', muted: false });
});
