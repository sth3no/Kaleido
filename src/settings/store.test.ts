import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Settings } from '../ipc/types';
import { DEFAULT_APPEARANCE } from '../theme/tokens';
import { isLoaded, useSettingsStore } from './store';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const SETTINGS: Settings = {
  version: 1,
  language: 'system',
  appearance: DEFAULT_APPEARANCE,
  playback: { openWhilePlaying: 'replace' },
  updates: { ytdlpChannel: 'stable' },
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
    expect(state.mpvLoaded).toBe(true);
    expect(state.kaleido).toEqual(SETTINGS);
  });

  test('an empty answer for the mpv options (the player is not up yet) is a read, but of no values', async () => {
    rust({ mpv: {}, settings: SETTINGS });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().status).toBe('ready');
    expect(useSettingsStore.getState().mpv).toEqual({});
    // Kaleido's own settings are there; the mpv options are not, and the page says so.
    expect(useSettingsStore.getState().mpvLoaded).toBe(false);
    expect(useSettingsStore.getState().kaleido).toEqual(SETTINGS);

    // Read again once the player is up.
    rust({ mpv: { hwdec: 'no' }, settings: SETTINGS });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().mpvLoaded).toBe(true);
    expect(useSettingsStore.getState().mpv).toEqual({ hwdec: 'no' });
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

  test('mpv values Rust took while the read was on its way are not undone by the read', async () => {
    const reply = deferred<unknown>();
    vi.mocked(invoke).mockImplementation(((command: string) =>
      command === 'settings_get_mpv' ? reply.promise : Promise.resolve(SETTINGS)) as unknown as typeof invoke);
    // An earlier visit left these.
    useSettingsStore.setState({ mpv: { hwdec: 'auto-safe', volume: '100' }, mpvLoaded: true });

    const loading = useSettingsStore.getState().load();
    // The page is open and its fields can be changed: Rust takes a value before the read answers,
    // and the read saw the old one.
    useSettingsStore.getState().setMpv('hwdec', 'no');
    reply.resolve({ hwdec: 'auto-safe', volume: '100', profile: null });
    await loading;

    // The newer value stays; the options that were not touched are the read's.
    expect(useSettingsStore.getState().mpv).toEqual({ hwdec: 'no', volume: '100', profile: null });
    expect(useSettingsStore.getState().mpvLoaded).toBe(true);
  });

  test('a value Rust took before the read began is the read\'s to replace', async () => {
    useSettingsStore.getState().setMpv('hwdec', 'no');
    rust({ mpv: { hwdec: 'auto-copy-safe', volume: '100' }, settings: SETTINGS });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().mpv).toEqual({ hwdec: 'auto-copy-safe', volume: '100' });
  });

  test('a setting is there when its own source has answered', () => {
    const mpv = { mpv: 'hwdec' };
    const own = { kaleido: 'playback.openWhilePlaying' };
    expect(isLoaded({ mpv: false, kaleido: false }, mpv)).toBe(false);
    expect(isLoaded({ mpv: false, kaleido: false }, own)).toBe(false);
    // The player is not up: Kaleido's settings are read, the mpv options have no values.
    expect(isLoaded({ mpv: false, kaleido: true }, mpv)).toBe(false);
    expect(isLoaded({ mpv: false, kaleido: true }, own)).toBe(true);
    expect(isLoaded({ mpv: true, kaleido: false }, mpv)).toBe(true);
    expect(isLoaded({ mpv: true, kaleido: false }, own)).toBe(false);
    expect(isLoaded({ mpv: true, kaleido: true }, mpv)).toBe(true);
    expect(isLoaded({ mpv: true, kaleido: true }, own)).toBe(true);
  });

  test('a value Rust took replaces the old one and leaves the rest', () => {
    useSettingsStore.setState({ mpv: { hwdec: 'auto-safe', volume: '100' } });
    useSettingsStore.getState().setMpv('hwdec', 'no');
    useSettingsStore.getState().setMpv('profile', null);
    expect(useSettingsStore.getState().mpv).toEqual({ hwdec: 'no', volume: '100', profile: null });
  });
});
