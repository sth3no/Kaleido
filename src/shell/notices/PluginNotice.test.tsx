import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../../i18n';
import type { PluginInfo, PluginsState } from '../../ipc/types';
import { usePluginsStore } from '../../plugins/pluginsStore';
import { MAX_NOTICES, NOTICE_MS, useNoticeStore } from '../../state/noticeStore';
import { usePlayerStore } from '../../state/playerStore';
import { useUiStore } from '../../state/uiStore';
import ErrorCards from './ErrorCards';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const events = vi.hoisted(() => ({
  handlers: new Map<string, ((event: { payload: unknown }) => void)[]>(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    events.handlers.set(name, [...(events.handlers.get(name) ?? []), handler]);
    return Promise.resolve(() => undefined);
  }),
}));

/** The timers the tests move (not `setImmediate`, which React's `act` waits on). */
const FAKE: NonNullable<Parameters<typeof vi.useFakeTimers>[0]>['toFake'] = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'Date',
  'performance',
  'requestAnimationFrame',
  'cancelAnimationFrame',
];

const plugin = (name: string, enabled = true): PluginInfo => ({
  name,
  scriptName: name,
  source: 'bundled',
  version: '1.0.0',
  summary: null,
  enabled,
  running: true,
  incompatible: false,
  duplicate: false,
  errors: 1,
  settings: 'schema',
  copyOf: null,
});

const state = (plugins: PluginInfo[]): PluginsState => ({
  plugins,
  restartNeeded: plugins.some((item) => !item.enabled),
  removedEssentials: [],
  applying: false,
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

/** How Rust answers; a throw is a rejection, as Rust's `Err`. */
function rust(answers: Answers = {}) {
  const all: Answers = {
    plugins_set_enabled: () => state([plugin('thumbfast', false)]),
    // What the stack asks for as it mounts (final review I-3): no plugin that reports errors.
    plugins_list: () => state([]),
    ...answers,
  };
  vi.mocked(invoke).mockImplementation((async (command: string, args?: unknown) =>
    all[command]?.(args) ?? null) as unknown as typeof invoke);
}

const sent = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

/** Rust sends an event: every listener hears it. */
const emit = (name: string, payload: unknown) => {
  act(() => {
    for (const handler of events.handlers.get(name) ?? []) handler({ payload });
  });
};

const pluginReportsErrors = (name: string) => {
  emit('plugins:error', { name });
};

/** Lets the answers that are on their way arrive, and what they set in motion run. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

/** The cards, newest first. */
const cards = () => screen.queryAllByRole('listitem');
const card = (name: string) => {
  const found = cards().find((item) => (item.textContent ?? '').includes(`Plugin ${name} reports errors`));
  if (!found) throw new Error(`no card for ${name}`);
  return found;
};

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: FAKE });
  events.handlers.clear();
  vi.mocked(invoke).mockReset();
  rust();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  useNoticeStore.setState(useNoticeStore.getInitialState(), true);
  usePluginsStore.setState(usePluginsStore.getInitialState(), true);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setLanguage('en');
});

describe('a plugin that reports errors (spec 10.4)', () => {
  test('a plugin error notice offers Disable once', async () => {
    render(<ErrorCards />);
    expect(cards()).toHaveLength(0);

    pluginReportsErrors('thumbfast');

    // One quiet card: what is wrong, that nothing is turned off, and two things to do.
    expect(cards()).toHaveLength(1);
    const first = within(card('thumbfast'));
    expect(first.getByText('Plugin thumbfast reports errors')).toBeTruthy();
    expect(first.getByText('It keeps running. Kaleido turns nothing off by itself.')).toBeTruthy();
    expect(
      first.getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent),
    ).toEqual(['Close', 'Disable', 'My plugins']);
    // Quiet: not an alert.
    expect(first.queryByRole('alert')).toBeNull();

    // Rust says it once for a plugin in a run; if it came again, there is still one card.
    pluginReportsErrors('thumbfast');
    expect(cards()).toHaveLength(1);

    // Disable is the plugin command, once.
    fireEvent.click(first.getByRole('button', { name: 'Disable' }));
    await settle();
    expect(sent('plugins_set_enabled')).toHaveLength(1);
    expect(sent('plugins_set_enabled')[0]?.[1]).toEqual({ name: 'thumbfast', enabled: false });

    // After it, the card says the change comes with Apply, and Disable is not offered again.
    const after = within(card('thumbfast'));
    expect(after.getByText('thumbfast is turned off. This takes effect after Apply.')).toBeTruthy();
    expect(after.queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(after.getByRole('button', { name: 'My plugins' })).toBeTruthy();
    expect(sent('plugins_set_enabled')).toHaveLength(1);
  });

  test('two plugins have a card each', () => {
    render(<ErrorCards />);

    pluginReportsErrors('thumbfast');
    pluginReportsErrors('reload');

    expect(cards()).toHaveLength(2);
    expect(within(cards()[0] as HTMLElement).getByText('Plugin reload reports errors')).toBeTruthy();
    expect(within(cards()[1] as HTMLElement).getByText('Plugin thumbfast reports errors')).toBeTruthy();
  });

  test('the link goes to My plugins, and Disable gives the page the state Rust answered with', async () => {
    render(<ErrorCards />);
    pluginReportsErrors('thumbfast');

    fireEvent.click(within(card('thumbfast')).getByRole('button', { name: 'Disable' }));
    await settle();
    // The plugins store has the answer, so that the page shows it as it opens.
    expect(usePluginsStore.getState().state?.restartNeeded).toBe(true);
    expect(usePluginsStore.getState().state?.plugins[0]?.enabled).toBe(false);

    fireEvent.click(within(card('thumbfast')).getByRole('button', { name: 'My plugins' }));

    expect(useUiStore.getState().page).toBe('plugins');
  });

  test('the card is announced politely, and again when the plugin is off', async () => {
    render(<ErrorCards />);
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');

    pluginReportsErrors('thumbfast');
    expect(region.textContent).toBe('Plugin thumbfast reports errors');

    fireEvent.click(within(card('thumbfast')).getByRole('button', { name: 'Disable' }));
    await settle();
    expect(region.textContent).toBe('thumbfast is turned off. This takes effect after Apply.');
  });

  test('a plugin that cannot be turned off says why, and Disable is offered again', async () => {
    rust({
      plugins_set_enabled: () => {
        throw { type: 'busy' };
      },
    });
    render(<ErrorCards />);
    pluginReportsErrors('thumbfast');

    fireEvent.click(within(card('thumbfast')).getByRole('button', { name: 'Disable' }));
    await settle();

    const failed = within(card('thumbfast'));
    expect(failed.getByRole('alert').textContent).toBe('Changes wait until Apply finishes.');
    expect(failed.getByRole('button', { name: 'Disable' }).getAttribute('aria-disabled')).toBe('false');

    // Again, when Apply is done.
    rust();
    fireEvent.click(failed.getByRole('button', { name: 'Disable' }));
    await settle();
    expect(within(card('thumbfast')).queryByRole('alert')).toBeNull();
    expect(within(card('thumbfast')).getByText(/is turned off/)).toBeTruthy();
    expect(sent('plugins_set_enabled')).toHaveLength(2);
  });

  test('a plugin that is gone says so and offers no Disable', async () => {
    rust({
      plugins_set_enabled: () => {
        throw { type: 'notFound', name: 'thumbfast' };
      },
    });
    render(<ErrorCards />);
    pluginReportsErrors('thumbfast');

    fireEvent.click(within(card('thumbfast')).getByRole('button', { name: 'Disable' }));
    await settle();

    const gone = within(card('thumbfast'));
    expect(gone.getByRole('alert').textContent).toContain('This plugin is gone.');
    expect(gone.queryByRole('button', { name: 'Disable' })).toBeNull();
  });

  test('the card goes after 8 s like the others, but not while Disable runs', async () => {
    const answer = deferred<PluginsState>();
    rust({ plugins_set_enabled: () => answer.promise });
    render(<ErrorCards />);
    pluginReportsErrors('thumbfast');

    fireEvent.click(within(card('thumbfast')).getByRole('button', { name: 'Disable' }));
    await settle();
    // The action runs: the button is off, and the card stays well past its 8 s.
    const button = within(card('thumbfast')).getByRole('button', { name: 'Disable' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    advance(NOTICE_MS * 3);
    expect(cards()).toHaveLength(1);
    expect(sent('plugins_set_enabled')).toHaveLength(1);

    // Done: the 8 s start over.
    answer.resolve(state([plugin('thumbfast', false)]));
    await settle();
    advance(NOTICE_MS - 1);
    expect(cards()).toHaveLength(1);
    advance(1);
    expect(cards()).toHaveLength(0);
  });

  test('the card of a plugin with no action running goes after 8 s', () => {
    render(<ErrorCards />);
    pluginReportsErrors('thumbfast');

    advance(NOTICE_MS - 1);
    expect(cards()).toHaveLength(1);
    advance(1);
    expect(cards()).toHaveLength(0);
  });

  test('a fourth card does not push out the card whose action runs', async () => {
    rust({ plugins_set_enabled: () => new Promise(() => undefined) });
    render(<ErrorCards />);
    pluginReportsErrors('first');
    fireEvent.click(within(card('first')).getByRole('button', { name: 'Disable' }));
    await settle();
    pluginReportsErrors('second');
    pluginReportsErrors('third');
    expect(MAX_NOTICES).toBe(3);
    expect(cards()).toHaveLength(3);

    pluginReportsErrors('fourth');

    // The oldest card that is not at work goes: the second.
    expect(cards()).toHaveLength(3);
    // Scoped to the cards: the polite live region repeats the title of the newest one.
    expect(() => card('second')).toThrow();
    expect(within(card('first')).getByText('Plugin first reports errors')).toBeTruthy();
    expect(within(card('third')).getByText('Plugin third reports errors')).toBeTruthy();
    expect(within(card('fourth')).getByText('Plugin fourth reports errors')).toBeTruthy();
  });

  test('Esc on the card closes it and does not reach mpv', () => {
    render(<ErrorCards />);
    pluginReportsErrors('thumbfast');
    const link = within(card('thumbfast')).getByRole('button', { name: 'My plugins' });
    link.focus();

    expect(fireEvent.keyDown(link, { key: 'Escape' })).toBe(false);

    expect(cards()).toHaveLength(0);
  });

  test('the card is in the language of the app', () => {
    render(<ErrorCards />);
    pluginReportsErrors('thumbfast');

    act(() => {
      setLanguage('cs');
    });

    // Scoped to the card: the polite live region repeats its title. (`card()` looks for English.)
    const czech = within(cards()[0] as HTMLElement);
    expect(czech.getByText('Plugin thumbfast hlásí chyby')).toBeTruthy();
    expect(czech.getByText('Dál běží. Kaleido sám nic nevypíná.')).toBeTruthy();
    expect(czech.getByRole('button', { name: 'Vypnout' })).toBeTruthy();
    expect(czech.getByRole('button', { name: 'Moje pluginy' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Plugin thumbfast hlásí chyby');
  });
});

describe('a plugin that broke before the UI listened (final review I-3)', () => {
  /** `name` as `plugins_list` has it, with `errors` logged in this run. */
  const reporting = (name: string, errors: number): PluginInfo => ({ ...plugin(name), errors });

  test('one that reports errors when the stack mounts gets its card, though no event came', async () => {
    let listening = false;
    rust({
      plugins_list: () => {
        // Asked for once the listener is in place: an event that comes meanwhile is not lost.
        listening = (events.handlers.get('plugins:error') ?? []).length > 0;
        return state([reporting('sub-select', 2), reporting('thumbfast', 0)]);
      },
    });

    render(<ErrorCards />);
    await settle();

    expect(listening).toBe(true);
    expect(sent('plugins_list')).toHaveLength(1);
    expect(cards()).toHaveLength(1);
    expect(within(card('sub-select')).getByText('Plugin sub-select reports errors')).toBeTruthy();
    expect(within(card('sub-select')).getByRole('button', { name: 'Disable' })).toBeTruthy();
  });

  test('the event for it that comes later makes no second card, also once the first has gone', async () => {
    rust({ plugins_list: () => state([reporting('sub-select', 2)]) });
    render(<ErrorCards />);
    await settle();
    expect(cards()).toHaveLength(1);

    pluginReportsErrors('sub-select');
    expect(cards()).toHaveLength(1);
    advance(NOTICE_MS);
    expect(cards()).toHaveLength(0);
    pluginReportsErrors('sub-select');
    expect(cards()).toHaveLength(0);
    // Another plugin's first error is told as before.
    pluginReportsErrors('thumbfast');
    expect(cards()).toHaveLength(1);
  });

  test('a plugin told by its event first gets no second card from the list', async () => {
    const list = deferred<PluginsState>();
    rust({ plugins_list: () => list.promise });
    render(<ErrorCards />);
    await settle();
    pluginReportsErrors('sub-select');
    expect(cards()).toHaveLength(1);

    list.resolve(state([reporting('sub-select', 1)]));
    await settle();

    expect(cards()).toHaveLength(1);
  });

  test('a list that cannot be read is only logged; the events still make their cards', async () => {
    rust({
      plugins_list: () => {
        throw { type: 'unavailable' };
      },
    });
    render(<ErrorCards />);
    await settle();

    expect(cards()).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith('cannot list the plugins that report errors', {
      type: 'unavailable',
    });
    pluginReportsErrors('thumbfast');
    expect(cards()).toHaveLength(1);
  });
});
