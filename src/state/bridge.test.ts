import { invoke } from '@tauri-apps/api/core';
import { listen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event';
import { renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { StreamFormats } from '../ipc/types';
import { useStreamStore } from '../streams/streamStore';
import { startPlayerBridge, usePlayerBridge } from './bridge';
import { usePlayerStore } from './playerStore';
import { useUiStore } from './uiStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

/** The events the bridge handles itself. */
const EVENTS = [
  'player:state',
  'player:file-loaded',
  'player:end-file',
  'player:log',
  'glass:state',
  'system:open-request',
  'stream:formats',
];

const LINK = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

/** What Rust says of a link that is being probed. */
const loading = (url: string): StreamFormats => ({ url, state: { type: 'loading' }, chosen: null });

/** What happened, in order: `listen <event>`, `unlisten <event>` and `invoke <command>`. */
let order: string[];
const handlers = new Map<string, EventCallback<unknown>>();
/** Every handler that was registered, also of a subscription that was let go since. */
let registered: { event: string; handler: EventCallback<unknown> }[];
/** Subscriptions that wait for `release()`; `null`: they are there at once. */
let held: (() => void)[] | null;
/** The event whose subscription fails. */
let failing: string | null;
/** What each command answers, made when it is asked. */
let answers: Record<string, () => Promise<unknown>>;

const release = () => {
  for (const resolve of held?.splice(0) ?? []) resolve();
};

const fire = (event: string, payload: unknown) => {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`nobody listens to ${event}`);
  handler({ event, id: 0, payload });
};

/** The event reaches every handler that was ever registered for it, as one that is in flight would. */
const fireAll = (event: string, payload: unknown) => {
  for (const entry of registered.filter((one) => one.event === event)) {
    entry.handler({ event, id: 0, payload });
  }
};

const steps = (kind: 'listen' | 'unlisten' | 'invoke') =>
  order.filter((step) => step.startsWith(`${kind} `));

const listening = () => expect(steps('listen')).toHaveLength(EVENTS.length);

beforeEach(() => {
  order = [];
  handlers.clear();
  registered = [];
  held = null;
  failing = null;
  answers = {
    system_ui_ready: () => Promise.resolve({ pause: true, 'time-pos': 1 }),
    glass_state: () => Promise.resolve({ enabled: true, reason: null }),
  };
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  useStreamStore.setState(useStreamStore.getInitialState(), true);
  vi.mocked(listen).mockImplementation(((event: string, handler: EventCallback<unknown>) => {
    order.push(`listen ${event}`);
    handlers.set(event, handler);
    registered.push({ event, handler });
    if (event === failing) return Promise.reject(new Error(`cannot listen to ${event}`));
    const unlisten: UnlistenFn = () => {
      order.push(`unlisten ${event}`);
    };
    return new Promise<UnlistenFn>((resolve) => {
      if (held) held.push(() => resolve(unlisten));
      else resolve(unlisten);
    });
  }) as unknown as typeof listen);
  vi.mocked(invoke).mockImplementation(((command: string) => {
    order.push(`invoke ${command}`);
    return answers[command]?.() ?? Promise.resolve(undefined);
  }) as unknown as typeof invoke);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startPlayerBridge', () => {
  test('bridge subscribes before asking for the snapshot', async () => {
    held = [];
    const started = startPlayerBridge();
    await vi.waitFor(listening);
    // Every event is asked for, but until all of them are there nothing is asked of Rust.
    expect(steps('invoke')).toEqual([]);

    release();
    await started;
    expect(order.slice(0, EVENTS.length).sort()).toEqual(EVENTS.map((event) => `listen ${event}`).sort());
    expect(order.slice(EVENTS.length)).toEqual(['invoke system_ui_ready', 'invoke glass_state']);
    expect(usePlayerStore.getState().props).toEqual({ pause: true, 'time-pos': 1 });
  });

  test('what Rust emits reaches the stores', async () => {
    const stop = await startPlayerBridge();

    fire('player:state', { changes: { pause: false, 'time-pos': 5 } });
    expect(usePlayerStore.getState().props).toEqual({ pause: false, 'time-pos': 5 });

    fire('player:file-loaded', {});
    expect(usePlayerStore.getState().loaded).toBe(true);

    fire('player:end-file', { reason: 'error', error: 'loading failed', file: null, continues: false, streamError: null });
    expect(usePlayerStore.getState().loaded).toBe(false);
    expect(usePlayerStore.getState().lastEnd).toEqual({ reason: 'error', error: 'loading failed', file: null, continues: false, streamError: null });

    fire('player:log', { level: 'warn', prefix: 'ffmpeg', text: 'Invalid NAL unit size' });
    expect(usePlayerStore.getState().logTail).toEqual([
      { level: 'warn', prefix: 'ffmpeg', text: 'Invalid NAL unit size' },
    ]);

    fire('glass:state', { enabled: false, reason: 'user' });
    expect(useUiStore.getState().glass).toEqual({ enabled: false, reason: 'user' });

    stop();
  });

  test('the player is the page when Rust opens something, also while it answers system_ui_ready', async () => {
    // The first launch's file plays inside system_ui_ready, which says so before it answers.
    let answer: (state: unknown) => void = () => undefined;
    answers.system_ui_ready = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    useUiStore.getState().setPage('settings');

    const started = startPlayerBridge();
    await vi.waitFor(() => expect(steps('invoke')).toContain('invoke system_ui_ready'));
    fire('system:open-request', { count: 1 });
    fire('player:state', { changes: { 'media-title': 'Duna' } });
    answer({ pause: false });
    await started;

    expect(useUiStore.getState().page).toBe('player');
    // What came meanwhile is kept, and the snapshot is added.
    expect(usePlayerStore.getState().props).toEqual({ 'media-title': 'Duna', pause: false });
  });

  test('asks whether the glass is on and keeps the answer', async () => {
    answers.glass_state = () => Promise.resolve({ enabled: false, reason: 'system' });
    await startPlayerBridge();
    expect(useUiStore.getState().glass).toEqual({ enabled: false, reason: 'system' });
  });

  test('a glass:state that comes while the glass is being asked for is newer than the answer', async () => {
    let answer: (state: unknown) => void = () => undefined;
    answers.glass_state = () =>
      new Promise((resolve) => {
        answer = resolve;
      });

    const started = startPlayerBridge();
    await vi.waitFor(() => expect(steps('invoke')).toContain('invoke glass_state'));
    fire('glass:state', { enabled: false, reason: 'gpuFailure' });
    answer({ enabled: true, reason: null });
    await started;

    expect(useUiStore.getState().glass).toEqual({ enabled: false, reason: 'gpuFailure' });
  });

  test('what Rust says of the link that plays reaches the stream store, and what it says of another link does not', async () => {
    const stop = await startPlayerBridge();

    fire('player:state', { changes: { path: LINK } });
    fire('stream:formats', loading(LINK));
    expect(useStreamStore.getState().formats).toEqual(loading(LINK));

    fire('stream:formats', loading('https://www.twitch.tv/kaleido'));
    expect(useStreamStore.getState().formats).toEqual(loading(LINK));
    stop();
  });

  test('the qualities of a link are asked for when the path becomes one, and for nothing else', async () => {
    answers.stream_formats = () => Promise.resolve({ ...loading(LINK), chosen: 'ba/b' });
    const stop = await startPlayerBridge();

    fire('player:state', { changes: { path: 'C:\\Videa\\a.mkv' } });
    expect(steps('invoke')).not.toContain('invoke stream_formats');

    fire('player:state', { changes: { path: LINK } });
    expect(steps('invoke')).toContain('invoke stream_formats');
    await vi.waitFor(() => {
      expect(useStreamStore.getState().formats?.chosen).toBe('ba/b');
    });
    stop();
  });

  test('a link that plays when the UI starts is asked for once its state has arrived', async () => {
    answers.system_ui_ready = () => Promise.resolve({ path: LINK, 'idle-active': false });
    answers.stream_formats = () => Promise.resolve(loading(LINK));

    await startPlayerBridge();
    await vi.waitFor(() => {
      expect(useStreamStore.getState().formats).toEqual(loading(LINK));
    });
    expect(steps('invoke')).toEqual(['invoke system_ui_ready', 'invoke glass_state', 'invoke stream_formats']);
  });

  test('stopping stops asking, and a stream:formats still on its way is ignored', async () => {
    const stop = await startPlayerBridge();
    fire('player:state', { changes: { path: LINK } });
    expect(steps('invoke').filter((step) => step === 'invoke stream_formats')).toHaveLength(1);

    stop();
    fire('stream:formats', loading(LINK));
    expect(useStreamStore.getState().formats).toBeNull();

    usePlayerStore.getState().applyChanges({ path: 'https://www.twitch.tv/kaleido' });
    expect(steps('invoke').filter((step) => step === 'invoke stream_formats')).toHaveLength(1);
  });

  test('stopping lets go of every listener, once, and an event still on its way is ignored', async () => {
    const stop = await startPlayerBridge();
    expect(steps('unlisten')).toEqual([]);
    stop();
    stop();
    expect(steps('unlisten').sort()).toEqual(EVENTS.map((event) => `unlisten ${event}`).sort());

    // Tauri's unlisten is asynchronous: an event that was sent before it is still delivered.
    fire('player:log', { level: 'warn', prefix: 'ffmpeg', text: 'late' });
    fire('player:state', { changes: { pause: false } });
    fire('player:file-loaded', {});
    fire('player:end-file', { reason: 'eof', error: null, file: null, continues: false, streamError: null });
    fire('glass:state', { enabled: false, reason: 'user' });
    fire('system:open-request', { count: 1 });
    expect(usePlayerStore.getState().logTail).toEqual([]);
    expect(usePlayerStore.getState().props).toEqual({ pause: true, 'time-pos': 1 });
    expect(usePlayerStore.getState().loaded).toBe(false);
    expect(usePlayerStore.getState().lastEnd).toBeNull();
    expect(useUiStore.getState().glass).toEqual({ enabled: true, reason: null });
  });

  test('stopping while it subscribes asks Rust for nothing and lets go', async () => {
    held = [];
    const abort = new AbortController();
    const started = startPlayerBridge(abort.signal);
    await vi.waitFor(listening);
    abort.abort();
    release();
    const stop = await started;

    expect(steps('invoke')).toEqual([]);
    expect(steps('unlisten')).toHaveLength(EVENTS.length);
    stop();
    expect(steps('unlisten')).toHaveLength(EVENTS.length);
  });

  test('stopping while the state is being asked for does not write it', async () => {
    let answer: (state: unknown) => void = () => undefined;
    answers.system_ui_ready = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const abort = new AbortController();

    const started = startPlayerBridge(abort.signal);
    await vi.waitFor(() => expect(steps('invoke')).toContain('invoke system_ui_ready'));
    abort.abort();
    answer({ pause: false });
    await started;

    expect(usePlayerStore.getState().props).toEqual({});
    expect(steps('unlisten')).toHaveLength(EVENTS.length);
  });

  test('a subscription that fails rejects, and the others are let go', async () => {
    failing = 'player:log';
    await expect(startPlayerBridge()).rejects.toThrow('cannot listen to player:log');
    expect(steps('invoke')).toEqual([]);
    expect(steps('unlisten')).toHaveLength(EVENTS.length - 1);
  });

  test('a state that cannot be read is reported, and the bridge goes on listening', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    answers.system_ui_ready = () => Promise.reject(new Error('no player'));

    await startPlayerBridge();
    expect(warn).toHaveBeenCalledWith('system_ui_ready', expect.any(Error));
    fire('player:state', { changes: { pause: true } });
    expect(usePlayerStore.getState().props).toEqual({ pause: true });
  });
});

describe('usePlayerBridge', () => {
  test('React running the effect twice still asks Rust for the state once and leaves one set of listeners', async () => {
    const { unmount } = renderHook(() => usePlayerBridge(), { wrapper: StrictMode });
    // The first run is let go as soon as its subscriptions are there.
    await vi.waitFor(() => expect(steps('unlisten')).toHaveLength(EVENTS.length));
    await vi.waitFor(() => expect(usePlayerStore.getState().props).toEqual({ pause: true, 'time-pos': 1 }));
    expect(steps('invoke')).toEqual(['invoke system_ui_ready', 'invoke glass_state']);
    expect(steps('listen')).toHaveLength(2 * EVENTS.length);

    // The first run's listeners were let go, but Tauri's unlisten is asynchronous, so an event
    // can still reach them: one line of the log is one line, not two.
    fireAll('player:log', { level: 'warn', prefix: 'ffmpeg', text: 'Invalid NAL unit size' });
    expect(usePlayerStore.getState().logTail).toEqual([
      { level: 'warn', prefix: 'ffmpeg', text: 'Invalid NAL unit size' },
    ]);
    fireAll('player:end-file', { reason: 'error', error: 'loading failed', file: null, continues: false, streamError: null });
    expect(usePlayerStore.getState().lastEnd).toEqual({ reason: 'error', error: 'loading failed', file: null, continues: false, streamError: null });

    unmount();
    await vi.waitFor(() => expect(steps('unlisten')).toHaveLength(2 * EVENTS.length));
  });
});
