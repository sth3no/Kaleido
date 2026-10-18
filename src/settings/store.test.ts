import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Settings } from '../ipc/types';
import { DEFAULT_APPEARANCE } from '../theme/tokens';
import { useSettingsStore } from './store';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const SETTINGS: Settings = {
  version: 1,
  language: 'system',
  appearance: DEFAULT_APPEARANCE,
  playback: { openWhilePlaying: 'replace' },
};

const APPENDING: Settings = { ...SETTINGS, playback: { openWhilePlaying: 'append' } };

/** A promise the test settles when it likes. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  vi.mocked(invoke).mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** How Rust answers the two reads. */
function rust(answers: { mpv?: unknown; settings?: unknown }) {
  vi.mocked(invoke).mockImplementation(((command: string) => {
    if (command === 'settings_get_mpv') return Promise.resolve(answers.mpv);
    if (command === 'settings_get') return Promise.resolve(answers.settings);
    return Promise.resolve(null);
  }) as unknown as typeof invoke);
}

describe('the settings store', () => {
  test('loads the mpv options and Kaleido\'s settings', async () => {
    rust({ mpv: { hwdec: 'auto-safe', profile: null }, settings: SETTINGS });
    expect(useSettingsStore.getState().status).toBe('idle');

    const loading = useSettingsStore.getState().load();
    expect(useSettingsStore.getState().status).toBe('loading');
    await loading;

    const state = useSettingsStore.getState();
    expect(state.status).toBe('ready');
    expect(state.mpv).toEqual({ hwdec: 'auto-safe', profile: null });
    expect(state.kaleido).toEqual(SETTINGS);
  });

  test('an empty answer for the mpv options (the player is not up yet) is still a loaded page', async () => {
    rust({ mpv: {}, settings: SETTINGS });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().status).toBe('ready');
    expect(useSettingsStore.getState().mpv).toEqual({});
  });

  test('settings that are not settings fail, and loading again can succeed', async () => {
    rust({ mpv: {}, settings: null });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().status).toBe('failed');
    expect(useSettingsStore.getState().kaleido).toBeNull();

    rust({ mpv: { hwdec: 'no' }, settings: SETTINGS });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().status).toBe('ready');
    expect(useSettingsStore.getState().mpv).toEqual({ hwdec: 'no' });
  });

  test('a command Rust rejects fails the load, and is logged', async () => {
    vi.mocked(invoke).mockImplementation((() => Promise.reject('no player')) as unknown as typeof invoke);
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().status).toBe('failed');
    expect(console.warn).toHaveBeenCalled();
  });

  test('a page opened again keeps what it has while it reads, and keeps it if the read fails', async () => {
    rust({ mpv: { hwdec: 'no' }, settings: SETTINGS });
    await useSettingsStore.getState().load();

    vi.mocked(invoke).mockImplementation((() => Promise.reject('gone')) as unknown as typeof invoke);
    const again = useSettingsStore.getState().load();
    expect(useSettingsStore.getState().status).toBe('ready');
    await again;
    expect(useSettingsStore.getState().status).toBe('ready');
    expect(useSettingsStore.getState().mpv).toEqual({ hwdec: 'no' });
  });

  test('settings that Rust pushed while the read was on its way are not undone by the read', async () => {
    const reply = deferred<unknown>();
    vi.mocked(invoke).mockImplementation(((command: string) =>
      command === 'settings_get' ? reply.promise : Promise.resolve({})) as unknown as typeof invoke);

    const loading = useSettingsStore.getState().load();
    // `settings:changed` comes before the answer to the read that began earlier.
    useSettingsStore.getState().setKaleido(APPENDING);
    reply.resolve(SETTINGS);
    await loading;

    expect(useSettingsStore.getState().kaleido).toEqual(APPENDING);
    expect(useSettingsStore.getState().status).toBe('ready');
  });

  test('a value Rust took replaces the old one and leaves the rest', () => {
    useSettingsStore.setState({ mpv: { hwdec: 'auto-safe', volume: '100' } });
    useSettingsStore.getState().setMpv('hwdec', 'no');
    useSettingsStore.getState().setMpv('profile', null);
    expect(useSettingsStore.getState().mpv).toEqual({ hwdec: 'no', volume: '100', profile: null });
  });
});
