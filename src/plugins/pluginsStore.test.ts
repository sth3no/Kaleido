import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { PluginInfo, PluginsState } from '../ipc/types';
import { listenToPlugins, restoreReport, usePluginsStore } from './pluginsStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const events = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    events.handlers.set(name, handler);
    return Promise.resolve(() => {
      events.handlers.delete(name);
    });
  }),
}));

const plugin = (name: string, over: Partial<PluginInfo> = {}): PluginInfo => ({
  name,
  scriptName: name,
  source: 'bundled',
  version: '1.0.0',
  summary: null,
  enabled: true,
  running: true,
  incompatible: false,
  duplicate: false,
  errors: 0,
  settings: 'schema',
  copyOf: null,
  ...over,
});

const state = (plugins: PluginInfo[], over: Partial<PluginsState> = {}): PluginsState => ({
  plugins,
  restartNeeded: false,
  removedEssentials: [],
  applying: false,
  ...over,
});

/** A promise the test settles when it likes. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type Answers = Record<string, (args: unknown) => unknown>;

function rust(answers: Answers) {
  vi.mocked(invoke).mockImplementation((async (command: string, args?: unknown) =>
    answers[command]?.(args) ?? null) as unknown as typeof invoke);
}

const sent = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

const store = usePluginsStore;

beforeEach(() => {
  store.setState(store.getInitialState(), true);
  events.handlers.clear();
  vi.mocked(invoke).mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reading', () => {
  test('load reads the plugins', async () => {
    rust({ plugins_list: () => state([plugin('thumbfast')]) });
    expect(store.getState().state).toBeNull();

    await store.getState().load();

    expect(store.getState().state?.plugins.map((item) => item.name)).toEqual(['thumbfast']);
    expect(store.getState().loadFailed).toBe(false);
  });

  test('a read that fails says so, and a state that came later is not undone by it', async () => {
    rust({
      plugins_list: () => {
        throw new Error('not ready');
      },
    });
    await store.getState().load();
    expect(store.getState().state).toBeNull();
    expect(store.getState().loadFailed).toBe(true);

    // Once there is a state, a failed read leaves it alone.
    store.getState().setState(state([plugin('reload')]));
    expect(store.getState().loadFailed).toBe(false);
    await store.getState().load();
    expect(store.getState().state?.plugins).toHaveLength(1);
    expect(store.getState().loadFailed).toBe(false);
  });

  test('an answer that is not the plugins is a failed read', async () => {
    rust({ plugins_list: () => null });

    await store.getState().load();

    expect(store.getState().state).toBeNull();
    expect(store.getState().loadFailed).toBe(true);
  });

  test('a read that was overtaken by a state does not replace it', async () => {
    const read = deferred<PluginsState>();
    rust({ plugins_list: () => read.promise });
    const loading = store.getState().load();

    store.getState().setState(state([plugin('reload')]));
    read.resolve(state([plugin('thumbfast')]));
    await loading;

    expect(store.getState().state?.plugins.map((item) => item.name)).toEqual(['reload']);
  });

  test('listenToPlugins follows plugins:changed until it is stopped', async () => {
    const stop = listenToPlugins();
    await Promise.resolve();
    const handler = events.handlers.get('plugins:changed');
    expect(handler).toBeDefined();

    handler?.({ payload: state([plugin('reload')]) });
    expect(store.getState().state?.plugins).toHaveLength(1);

    stop();
    handler?.({ payload: state([plugin('reload'), plugin('thumbfast')]) });
    expect(store.getState().state?.plugins).toHaveLength(1);
  });
});

describe('changes', () => {
  test('setEnabled marks the plugin busy until Rust has answered, and takes the answer', async () => {
    const answer = deferred<PluginsState>();
    rust({ plugins_set_enabled: () => answer.promise });

    const changing = store.getState().setEnabled('thumbfast', false);
    expect(store.getState().busy.has('thumbfast')).toBe(true);
    // The same plugin again while it runs: nothing is sent twice.
    await store.getState().setEnabled('thumbfast', true);
    expect(sent('plugins_set_enabled')).toHaveLength(1);

    answer.resolve(state([plugin('thumbfast', { enabled: false })], { restartNeeded: true }));
    await changing;

    expect(store.getState().busy.has('thumbfast')).toBe(false);
    expect(store.getState().state?.restartNeeded).toBe(true);
    expect(sent('plugins_set_enabled')[0]?.[1]).toEqual({ name: 'thumbfast', enabled: false });
  });

  test('two plugins can change at the same time', async () => {
    const first = deferred<PluginsState>();
    const second = deferred<PluginsState>();
    const answers = [first.promise, second.promise];
    rust({ plugins_set_enabled: () => answers.shift() });

    const a = store.getState().setEnabled('a', false);
    const b = store.getState().setEnabled('b', false);
    expect([...store.getState().busy].sort()).toEqual(['a', 'b']);

    first.resolve(state([]));
    await a;
    expect([...store.getState().busy]).toEqual(['b']);
    second.resolve(state([]));
    await b;
    expect(store.getState().busy.size).toBe(0);
  });

  test('a refusal is kept for the plugin it concerns, and the next action clears it', async () => {
    rust({
      plugins_set_enabled: () => {
        throw { type: 'io', message: 'access denied' };
      },
    });

    await store.getState().setEnabled('uosc', false);

    expect(store.getState().error).toEqual({ name: 'uosc', code: 'io', message: 'access denied' });
    expect(store.getState().busy.size).toBe(0);

    rust({ plugins_set_enabled: () => state([]) });
    await store.getState().setEnabled('reload', false);
    expect(store.getState().error).toBeNull();
  });

  test('a plugin that is gone reads the list again', async () => {
    rust({
      plugins_set_enabled: () => {
        throw { type: 'notFound', name: 'uosc' };
      },
      plugins_list: () => state([plugin('reload')]),
    });

    await store.getState().setEnabled('uosc', false);
    await vi.waitFor(() => {
      expect(store.getState().state?.plugins).toHaveLength(1);
    });

    expect(store.getState().error?.code).toBe('notFound');
    expect(sent('plugins_list')).toHaveLength(1);
  });

  test('"changes wait until Apply finishes" goes when a state without Apply running arrives', async () => {
    rust({
      plugins_set_enabled: () => {
        throw { type: 'busy' };
      },
    });
    await store.getState().setEnabled('reload', false);
    expect(store.getState().error?.code).toBe('busy');

    // Apply is still running: it stays.
    store.getState().setState(state([], { applying: true }));
    expect(store.getState().error?.code).toBe('busy');
    store.getState().setState(state([], { applying: false }));
    expect(store.getState().error).toBeNull();
  });

  test('uninstall says whether it happened', async () => {
    rust({ plugins_uninstall: () => state([], { removedEssentials: ['reload'] }) });
    expect(await store.getState().uninstall('reload')).toBe(true);
    expect(store.getState().state?.removedEssentials).toEqual(['reload']);
    expect(sent('plugins_uninstall')[0]?.[1]).toEqual({ name: 'reload' });

    rust({
      plugins_uninstall: () => {
        throw { type: 'io', message: 'in use' };
      },
    });
    expect(await store.getState().uninstall('thumbfast')).toBe(false);
    expect(store.getState().error).toMatchObject({ name: 'thumbfast', code: 'io' });
  });
});

describe('apply', () => {
  test('apply is pending until the call returns, which is after the state said it ended', async () => {
    const answer = deferred<PluginsState>();
    rust({ plugins_apply: () => answer.promise });

    const applying = store.getState().apply();
    expect(store.getState().applyPending).toBe(true);
    // A second Apply while it runs sends nothing.
    await store.getState().apply();
    expect(sent('plugins_apply')).toHaveLength(1);

    // Rust says it ended; the call has not returned yet.
    store.getState().setState(state([], { applying: false }));
    expect(store.getState().applyPending).toBe(true);

    answer.resolve(state([]));
    await applying;
    expect(store.getState().applyPending).toBe(false);
  });

  test('no Apply starts while Rust says one runs', async () => {
    rust({ plugins_apply: () => state([]) });
    store.getState().setState(state([], { applying: true }));

    await store.getState().apply();

    expect(sent('plugins_apply')).toHaveLength(0);
  });

  test('an Apply that could not restart the player is kept for the bar, and the list is read again', async () => {
    rust({
      plugins_apply: () => {
        throw { type: 'unavailable' };
      },
      plugins_list: () => state([plugin('reload')], { restartNeeded: true }),
    });

    await store.getState().apply();

    expect(store.getState().applyProblem?.code).toBe('unavailable');
    expect(store.getState().applyPending).toBe(false);
    await vi.waitFor(() => {
      expect(store.getState().state?.restartNeeded).toBe(true);
    });
  });

  test('an Apply that was refused as busy says nothing: the one that runs ends with its own state', async () => {
    rust({
      plugins_apply: () => {
        throw { type: 'busy' };
      },
      plugins_list: () => state([], { applying: true }),
    });

    await store.getState().apply();

    expect(store.getState().applyProblem).toBeNull();
    expect(store.getState().applyPending).toBe(false);
  });
});

describe('restore essentials', () => {
  test('restoreReport names what came back and what is blocked', () => {
    const after = state([plugin('reload'), plugin('thumbfast.lua', { source: 'manual' })], {
      removedEssentials: ['sub-select'],
    });

    expect(restoreReport(['reload', 'thumbfast', 'sub-select'], after)).toEqual({
      back: ['reload'],
      // thumbfast is neither listed as an essential nor offered; sub-select is still offered.
      blocked: ['thumbfast'],
    });
    expect(restoreReport(['sub-select'], after)).toBeNull();
    expect(restoreReport([], after)).toBeNull();
  });

  test('restoreEssentials compares what was offered before with what Rust says after', async () => {
    store.getState().setState(state([plugin('thumbfast')], { removedEssentials: ['reload', 'sub-select'] }));
    rust({
      plugins_restore_essentials: () =>
        state([plugin('thumbfast'), plugin('reload'), plugin('sub-select.lua', { source: 'manual' })]),
    });

    await store.getState().restoreEssentials();

    expect(store.getState().restored).toEqual({ back: ['reload'], blocked: ['sub-select'] });
    expect(store.getState().restoring).toBe(false);
    expect(store.getState().state?.removedEssentials).toEqual([]);
  });

  test('a second restore while one runs is not sent, and the old report goes when a new one starts', async () => {
    const answer = deferred<PluginsState>();
    store.getState().setState(state([], { removedEssentials: ['reload'] }));
    store.setState({ restored: { back: ['sub-select'], blocked: [] } });
    rust({ plugins_restore_essentials: () => answer.promise });

    const first = store.getState().restoreEssentials();
    expect(store.getState().restored).toBeNull();
    await store.getState().restoreEssentials();
    expect(sent('plugins_restore_essentials')).toHaveLength(1);

    answer.resolve(state([plugin('reload')]));
    await first;
    expect(store.getState().restored).toEqual({ back: ['reload'], blocked: [] });
  });

  test('a restore Rust refuses is kept for the button', async () => {
    store.getState().setState(state([], { removedEssentials: ['reload'] }));
    rust({
      plugins_restore_essentials: () => {
        throw { type: 'io', message: 'cannot save plugins.json' };
      },
    });

    await store.getState().restoreEssentials();

    expect(store.getState().restoreProblem).toEqual({ code: 'io', message: 'cannot save plugins.json' });
    expect(store.getState().restored).toBeNull();
    expect(store.getState().restoring).toBe(false);
  });

  test('leaving the page clears what it said about the last actions', () => {
    store.setState({
      error: { name: 'uosc', code: 'busy', message: '' },
      applyProblem: { code: 'unavailable', message: '' },
      restoreProblem: { code: 'io', message: 'x' },
      restored: { back: ['reload'], blocked: [] },
    });

    store.getState().leave();

    expect(store.getState().error).toBeNull();
    expect(store.getState().applyProblem).toBeNull();
    expect(store.getState().restoreProblem).toBeNull();
    expect(store.getState().restored).toBeNull();
  });
});
