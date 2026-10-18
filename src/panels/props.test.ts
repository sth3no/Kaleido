import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { numberProp, selectedTrackId, sendCommand } from './props';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

const tracks = [
  { id: 1, type: 'sub', lang: 'cs' },
  { id: 2, type: 'sub', lang: 'en', selected: true },
  { id: 1, type: 'audio', lang: 'en', selected: true },
  { id: 2, type: 'audio', lang: 'cs' },
];

describe('numberProp', () => {
  test('is the number mpv reported, else the fallback', () => {
    expect(numberProp({ 'sub-delay': 0.3 }, 'sub-delay', 0)).toBe(0.3);
    expect(numberProp({}, 'sub-delay', 0)).toBe(0);
    expect(numberProp({ 'sub-delay': null }, 'sub-delay', 0)).toBe(0);
    expect(numberProp({ 'sub-delay': 'x' }, 'sub-delay', 5)).toBe(5);
    expect(numberProp({ 'sub-delay': Number.NaN }, 'sub-delay', 5)).toBe(5);
  });
});

describe('selectedTrackId', () => {
  test('is what mpv reports as sid and aid', () => {
    expect(selectedTrackId({ 'track-list': tracks, sid: 1, aid: 2 }, 'sub')).toBe(1);
    expect(selectedTrackId({ 'track-list': tracks, sid: 1, aid: 2 }, 'audio')).toBe(2);
  });

  test('is null when mpv says no track (it arrives as null), whatever the list marks', () => {
    expect(selectedTrackId({ 'track-list': tracks, sid: null }, 'sub')).toBeNull();
    expect(selectedTrackId({ 'track-list': tracks, aid: null }, 'audio')).toBeNull();
  });

  test('is the selected track of the list before mpv has reported it', () => {
    expect(selectedTrackId({ 'track-list': tracks }, 'sub')).toBe(2);
    expect(selectedTrackId({ 'track-list': tracks }, 'audio')).toBe(1);
  });

  test('is null with no track list and no report', () => {
    expect(selectedTrackId({}, 'sub')).toBeNull();
    expect(selectedTrackId({ 'track-list': [{ id: 1, type: 'sub' }] }, 'sub')).toBeNull();
  });
});

describe('sendCommand', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  test('sends the command to the player', () => {
    sendCommand({ type: 'playlistPlay', index: 2 });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('player_command', {
      cmd: { type: 'playlistPlay', index: 2 },
    });
  });

  test('a refusal goes to the log, not to the user', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(invoke).mockRejectedValueOnce('invalid');
    sendCommand({ type: 'playlistPlay', index: 2 });
    try {
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith('player_command', 'playlistPlay', 'invalid');
      });
    } finally {
      warn.mockRestore();
    }
  });
});
