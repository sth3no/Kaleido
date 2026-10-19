import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../i18n';
import type {
  LogLine,
  PluginInfo,
  PluginSettings as PluginSettingsData,
  PluginsState,
  SettingSpec,
} from '../ipc/types';
import AppShell from '../shell/AppShell';
import { usePlayerStore } from '../state/playerStore';
import { useUiStore } from '../state/uiStore';
import PluginsPage from './PluginsPage';
import { usePluginsStore } from './pluginsStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const events = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    events.handlers.set(name, handler);
    return Promise.resolve(() => undefined);
  }),
}));
const appWindow = vi.hoisted(() => ({
  minimize: vi.fn(() => Promise.resolve()),
  toggleMaximize: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  isMaximized: vi.fn(() => Promise.resolve(false)),
  onResized: vi.fn(() => Promise.resolve(() => undefined)),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => appWindow }));

// --- What Rust says ---------------------------------------------------------------------------

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

const THUMBFAST = plugin('thumbfast', {
  version: '2.0',
  summary: { en: 'Previews on the seek bar.', cs: 'Náhledy na posuvníku.' },
});
/** An interface of its own over the video (spec 6.5), added by hand. */
const UOSC = plugin('uosc', { source: 'manual', version: null, incompatible: true, settings: 'keyValue' });
/** The user's own thumbfast beside the essential: the two run, one numbered. */
const COPY = plugin('thumbfast.lua', {
  source: 'manual',
  version: null,
  duplicate: true,
  copyOf: 'thumbfast',
  settings: 'keyValue',
});
const RELOAD = plugin('reload', { errors: 3, version: '1.1' });
/** Turned off and still running: it stops at Apply. */
const SUB_SELECT = plugin('sub-select', { enabled: false, running: true });

const LIST = [THUMBFAST, UOSC, COPY, RELOAD, SUB_SELECT];

/** The form of an essential's schema: a slider, a list and a text field. */
const FORM: SettingSpec[] = [
  {
    key: 'max_height',
    type: 'int',
    default: 200,
    min: 50,
    max: 600,
    label: { en: 'Maximum height', cs: 'Nejvyšší výška' },
  },
  { key: 'mode', type: 'enum', default: 'fast', values: ['fast', 'slow'], label: { en: 'Mode' } },
  { key: 'prefix', type: 'string', default: 'thumb', label: { en: 'Prefix' } },
];

/** What a plugin's settings are: the essentials have a schema, the others keys and values. */
const settingsFor = (name: string): PluginSettingsData =>
  name === 'thumbfast' || name === 'sub-select'
    ? { name, schema: FORM, entries: [], managed: [] }
    : { name, schema: null, entries: [{ key: 'fps', value: '30' }], managed: [] };

type Answers = Record<string, (args: unknown) => unknown>;

/** The state `plugins_list` answers with. */
let current: PluginsState;

/** How Rust answers the commands; `answers` replaces some. A throw is a rejection, as Rust's `Err`. */
function rust(answers: Answers = {}) {
  const all: Answers = {
    plugins_list: () => current,
    plugins_log: () => [],
    plugins_settings: (args) => settingsFor((args as { name: string }).name),
    // The shell asks for the player and the glass; the answers never come.
    system_ui_ready: () => new Promise(() => undefined),
    glass_state: () => new Promise(() => undefined),
    ...answers,
  };
  vi.mocked(invoke).mockImplementation((async (command: string, args?: unknown) =>
    all[command]?.(args) ?? null) as unknown as typeof invoke);
}

const sent = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

/** Rust sends an event. */
function emit(name: string, payload: unknown) {
  const handler = events.handlers.get(name);
  if (!handler) throw new Error(`the page does not listen to ${name}`);
  act(() => {
    handler({ payload });
  });
}

/** Lets the answers that are on their way arrive, and what they set in motion run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The page, once the plugins are read. */
async function open() {
  const view = render(<PluginsPage />);
  await settle();
  return view;
}

const row = (name: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-plugin="${name}"]`);
  if (!found) throw new Error(`no row for ${name}`);
  return found;
};
const names = () =>
  Array.from(document.querySelectorAll('[data-plugin]')).map((li) => li.getAttribute('data-plugin'));
const switchOf = (name: string) => within(row(name)).getByRole('switch') as HTMLButtonElement;
const uninstallOf = (name: string) =>
  within(row(name)).getByRole('button', { name: `Uninstall ${name}` }) as HTMLButtonElement;
const settingsOf = (name: string) =>
  within(row(name)).getByRole('button', { name: `Settings of ${name}` }) as HTMLButtonElement;
const applyRegion = () => screen.getByRole('status', { name: 'Changes waiting' });
const restoreRegion = () => screen.getByRole('status', { name: 'Result of restoring' });
const heading = () => screen.getByRole('heading', { level: 1 });

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  usePluginsStore.setState(usePluginsStore.getInitialState(), true);
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  events.handlers.clear();
  vi.mocked(invoke).mockReset();
  current = state(LIST);
  rust();
  // What Rust refuses is logged, and some tests make it.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  setLanguage('en');
});

describe('the list', () => {
  test('each plugin shows its source, version and badges', async () => {
    await open();

    expect(heading().textContent).toBe('My plugins');
    // The order is Rust's: the order mpv loads them in.
    expect(names()).toEqual(['thumbfast', 'uosc', 'thumbfast.lua', 'reload', 'sub-select']);

    // An essential: its source, its version, what it does.
    const essential = within(row('thumbfast'));
    expect(essential.getByText('thumbfast')).toBeTruthy();
    expect(essential.getByText('Essentials')).toBeTruthy();
    expect(essential.getByText('Version 2.0')).toBeTruthy();
    expect(essential.getByText('Previews on the seek bar.')).toBeTruthy();
    expect(essential.queryByText('Incompatible')).toBeNull();
    expect(essential.queryByText('Duplicate')).toBeNull();
    expect(essential.queryByRole('button', { name: /Reports errors/ })).toBeNull();
    expect(switchOf('thumbfast').getAttribute('aria-checked')).toBe('true');

    // One that draws its own interface: labelled, with the reason in the row (spec 6.5). It has no
    // version to show.
    const clash = within(row('uosc'));
    expect(clash.getByText('Added by hand')).toBeTruthy();
    expect(clash.getByText('Incompatible')).toBeTruthy();
    expect(clash.getByText(/draws its own interface over the video/)).toBeTruthy();
    expect(clash.queryByText(/^Version/)).toBeNull();

    // The user's own copy of an essential: a duplicate, and whose script it is.
    const copy = within(row('thumbfast.lua'));
    expect(copy.getByText('Duplicate')).toBeTruthy();
    expect(copy.getByText(/mpv numbers one of them/)).toBeTruthy();
    expect(copy.getByText(/Your own copy of the essential thumbfast/)).toBeTruthy();
    expect(copy.getByText(/depend on your own script and settings/)).toBeTruthy();

    // Errors in this run: the badge says how many, and is a button.
    const noisy = within(row('reload')).getByRole('button', { name: 'Reports errors: 3' });
    expect(noisy.getAttribute('aria-expanded')).toBe('false');

    // Off, and still running until Apply.
    expect(switchOf('sub-select').getAttribute('aria-checked')).toBe('false');
    expect(within(row('sub-select')).getByText(/keeps running until you apply/)).toBeTruthy();
    expect(within(row('thumbfast')).queryByText(/keeps running until you apply/)).toBeNull();
  });

  test('a switch is named by its plugin, and every row has a Settings button', async () => {
    await open();

    expect(screen.getAllByRole('switch').map((item) => item.getAttribute('aria-checked'))).toEqual([
      'true',
      'true',
      'true',
      'true',
      'false',
    ]);
    expect(screen.getByRole('switch', { name: 'thumbfast' })).toBe(switchOf('thumbfast'));
    // Both forms of settings have it, and each is named by its plugin.
    expect(screen.getAllByRole('button', { name: /^Settings of / })).toHaveLength(5);
    for (const { name } of LIST) {
      expect(settingsOf(name).getAttribute('aria-expanded')).toBe('false');
      expect(settingsOf(name).textContent).toBe('Settings');
    }
    // Nothing is read until the settings are opened.
    expect(sent('plugins_settings')).toHaveLength(0);
  });

  test('the texts follow the language of the app', async () => {
    await open();
    act(() => {
      setLanguage('cs');
    });

    expect(heading().textContent).toBe('Moje pluginy');
    expect(within(row('thumbfast')).getByText('Náhledy na posuvníku.')).toBeTruthy();
    expect(within(row('thumbfast')).getByText('Verze 2.0')).toBeTruthy();
    expect(within(row('uosc')).getByText('Ručně přidaný')).toBeTruthy();
    expect(within(row('uosc')).getByText('Nekompatibilní')).toBeTruthy();
    expect(within(row('reload')).getByRole('button', { name: 'Hlásí chyby: 3' })).toBeTruthy();
    expect(within(row('thumbfast')).getByRole('button', { name: 'Odinstalovat thumbfast' })).toBeTruthy();
    expect(
      within(row('thumbfast')).getByRole('button', { name: 'Nastavení pluginu thumbfast' }),
    ).toBeTruthy();
  });

  test('says that it is reading, and that there are no plugins', async () => {
    let answer: (value: PluginsState) => void = () => undefined;
    rust({ plugins_list: () => new Promise<PluginsState>((resolve) => (answer = resolve)) });
    render(<PluginsPage />);
    expect(screen.getByText('Loading…')).toBeTruthy();

    act(() => {
      answer(state([]));
    });
    await settle();
    expect(screen.getByText('There are no plugins yet.')).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  test('a list that cannot be read says so and reads again on request', async () => {
    rust({
      plugins_list: () => {
        throw new Error('the player is not ready');
      },
    });
    await open();
    expect(screen.getByRole('alert').textContent).toContain('The plugins could not be read.');

    rust();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(names()).toHaveLength(5);
  });

  test('follows plugins:changed, and a read that was overtaken does not undo it', async () => {
    let answer: (value: PluginsState) => void = () => undefined;
    rust({ plugins_list: () => new Promise<PluginsState>((resolve) => (answer = resolve)) });
    render(<PluginsPage />);
    await settle();

    // Rust changed something while the first read was on its way, and the read is older.
    emit('plugins:changed', state([THUMBFAST, RELOAD]));
    act(() => {
      answer(state(LIST));
    });
    await settle();
    expect(names()).toEqual(['thumbfast', 'reload']);

    // A plugin logs an error: its count grows and its badge says so.
    emit('plugins:changed', state([THUMBFAST, { ...RELOAD, errors: 4 }]));
    expect(within(row('reload')).getByRole('button', { name: 'Reports errors: 4' })).toBeTruthy();
  });
});

describe('the switch and the apply bar', () => {
  test('the switch disables a plugin and the apply bar appears', async () => {
    rust({
      plugins_set_enabled: () =>
        state([{ ...THUMBFAST, enabled: false }, UOSC, COPY, RELOAD, SUB_SELECT], {
          restartNeeded: true,
        }),
    });
    await open();
    // Nothing waits: the region is in the page (so that it is announced) and says nothing.
    expect(applyRegion().textContent).toBe('');
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();

    fireEvent.click(switchOf('thumbfast'));
    await settle();

    expect(sent('plugins_set_enabled')).toHaveLength(1);
    expect(sent('plugins_set_enabled')[0]?.[1]).toEqual({ name: 'thumbfast', enabled: false });
    expect(switchOf('thumbfast').getAttribute('aria-checked')).toBe('false');
    expect(switchOf('thumbfast').getAttribute('aria-disabled')).toBe('false');
    const bar = within(applyRegion());
    expect(applyRegion().textContent).toContain('The changes take effect when the player restarts.');
    expect(applyRegion().textContent).toContain('It continues from the same place.');
    expect(bar.getByRole('button', { name: 'Apply' }).getAttribute('aria-disabled')).toBe('false');
  });

  test('turning a plugin on is the same switch, and Rust’s answer is what the row shows', async () => {
    rust({
      plugins_set_enabled: () => state([THUMBFAST, UOSC, COPY, RELOAD, { ...SUB_SELECT, enabled: true }]),
    });
    await open();

    fireEvent.click(switchOf('sub-select'));
    await settle();

    expect(sent('plugins_set_enabled')[0]?.[1]).toEqual({ name: 'sub-select', enabled: true });
    expect(switchOf('sub-select').getAttribute('aria-checked')).toBe('true');
    // Turned on while it runs: nothing waits for Apply.
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  test('apply is disabled while it runs and the bar goes when it is done', async () => {
    const waiting = state([THUMBFAST, UOSC, COPY, RELOAD, SUB_SELECT], { restartNeeded: true });
    let finish: (value: PluginsState) => void = () => undefined;
    rust({ plugins_apply: () => new Promise<PluginsState>((resolve) => (finish = resolve)) });
    current = waiting;
    await open();
    const apply = screen.getByRole('button', { name: 'Apply' });
    apply.focus();

    // Enter on the button: a click with no click count.
    fireEvent.click(apply, { detail: 0 });
    await settle();
    expect(sent('plugins_apply')).toHaveLength(1);
    // Rust has started: the first of the two states it sends.
    emit('plugins:changed', { ...waiting, applying: true });

    const running = screen.getByRole('button', { name: 'Applying…' });
    expect(running.getAttribute('aria-disabled')).toBe('true');
    expect(applyRegion().textContent).toContain('Restarting the player…');
    // The button stays where it is (it is not `disabled`), so that the keyboard keeps its place.
    expect(document.activeElement).toBe(running);
    expect(switchOf('thumbfast').getAttribute('aria-disabled')).toBe('true');
    expect(uninstallOf('thumbfast').getAttribute('aria-disabled')).toBe('true');

    // Nothing is done meanwhile: not a second Apply, not a change.
    fireEvent.click(running);
    fireEvent.click(switchOf('thumbfast'));
    fireEvent.click(uninstallOf('thumbfast'));
    await settle();
    expect(sent('plugins_apply')).toHaveLength(1);
    expect(sent('plugins_set_enabled')).toHaveLength(0);
    expect(within(row('thumbfast')).queryByRole('group')).toBeNull();

    // The new core plays on: Rust says so, and the call returns.
    const done = state([THUMBFAST, UOSC, COPY, RELOAD, { ...SUB_SELECT, running: false }]);
    emit('plugins:changed', done);
    act(() => {
      finish(done);
    });
    await settle();

    expect(screen.queryByRole('button', { name: /Appl/ })).toBeNull();
    expect(applyRegion().textContent).toBe('');
    expect(switchOf('thumbfast').getAttribute('aria-disabled')).toBe('false');
    // The button went with the focus on it: the keyboard starts again at the top of the page.
    expect(document.activeElement).toBe(heading());
  });

  test('the card scrolls a focused row clear of the apply bar: the bar says how tall it is', async () => {
    let height = 64;
    let measured: () => void = () => undefined;
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height);
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn(function (callback: () => void) {
        measured = callback;
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    try {
      current = state(LIST, { restartNeeded: true });
      await open();
      const card = applyRegion().closest<HTMLElement>('[aria-busy]');
      expect(card?.style.getPropertyValue('--plugins-bar-height')).toBe('64px');

      // The bar grows when the window narrows (its text wraps) ...
      height = 96;
      act(() => {
        measured();
      });
      expect(card?.style.getPropertyValue('--plugins-bar-height')).toBe('96px');

      // ... and is nothing once there is nothing to apply.
      height = 0;
      emit('plugins:changed', state(LIST));
      act(() => {
        measured();
      });
      expect(card?.style.getPropertyValue('--plugins-bar-height')).toBe('0px');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('the page does not react to the player being idle and empty during the restart', async () => {
    current = state(LIST, { restartNeeded: true, applying: true });
    await open();

    act(() => {
      usePlayerStore.setState({ loaded: false, props: { 'idle-active': true } });
    });

    expect(names()).toHaveLength(5);
    expect(applyRegion().textContent).toContain('Restarting the player…');
    expect(screen.getByRole('button', { name: 'Applying…' }).getAttribute('aria-disabled')).toBe('true');
  });

  test('a restart that could not be made says so, and the changes still wait', async () => {
    current = state(LIST, { restartNeeded: true });
    rust({
      plugins_apply: () => {
        throw { type: 'unavailable' };
      },
    });
    await open();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await settle();

    expect(screen.getByRole('alert').textContent).toContain(
      'The player is not running or could not be restarted.',
    );
    // The bar stays, and Apply can be tried again.
    expect(screen.getByRole('button', { name: 'Apply' }).getAttribute('aria-disabled')).toBe('false');
  });
});

describe('uninstall', () => {
  test('uninstall asks in the row and says the files go to the Recycle Bin', async () => {
    const after = state([UOSC, COPY, RELOAD, SUB_SELECT], {
      restartNeeded: true,
      removedEssentials: ['thumbfast'],
    });
    rust({ plugins_uninstall: () => after });
    await open();
    const ask = uninstallOf('thumbfast');
    expect(ask.getAttribute('aria-expanded')).toBe('false');

    // Enter on the button.
    fireEvent.click(ask, { detail: 0 });

    // The question is in the row, in the flow of the page, and nothing is done yet.
    const group = within(row('thumbfast')).getByRole('group', { name: /Uninstall thumbfast\?/ });
    expect(group.textContent).toContain('Recycle Bin');
    expect(group.textContent).toContain('your settings for it stay');
    // An essential can be brought back, and says so.
    expect(group.textContent).toContain('Restore essentials');
    expect(ask.getAttribute('aria-expanded')).toBe('true');
    expect(sent('plugins_uninstall')).toHaveLength(0);
    // The focus is on the answer that changes nothing.
    const cancel = within(group).getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);

    // Esc closes it, mpv does not get the key, and the focus is back on the button.
    expect(fireEvent.keyDown(cancel, { key: 'Escape' })).toBe(false);
    expect(within(row('thumbfast')).queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(ask);

    // Cancel closes it too.
    fireEvent.click(ask, { detail: 0 });
    fireEvent.click(within(row('thumbfast')).getByRole('button', { name: 'Cancel' }), { detail: 0 });
    expect(within(row('thumbfast')).queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(ask);
    expect(sent('plugins_uninstall')).toHaveLength(0);

    // Confirm does it.
    fireEvent.click(ask, { detail: 0 });
    fireEvent.click(within(row('thumbfast')).getByRole('button', { name: 'Confirm' }), { detail: 0 });
    await settle();

    expect(sent('plugins_uninstall')).toHaveLength(1);
    expect(sent('plugins_uninstall')[0]?.[1]).toEqual({ name: 'thumbfast' });
    expect(names()).toEqual(['uosc', 'thumbfast.lua', 'reload', 'sub-select']);
    // The row went, and the focus with it: it is on the next row's switch.
    expect(document.activeElement).toBe(switchOf('uosc'));
    // A plugin that runs keeps running until Apply, and the essential can be brought back.
    expect(within(applyRegion()).getByRole('button', { name: 'Apply' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restore essentials' })).toBeTruthy();
  });

  test('a script added by hand is asked about too, without the line about essentials', async () => {
    await open();

    fireEvent.click(uninstallOf('uosc'));

    const group = within(row('uosc')).getByRole('group');
    expect(group.textContent).toContain('Recycle Bin');
    expect(group.textContent).not.toContain('Restore essentials');
  });

  test('only one row asks at a time', async () => {
    await open();

    fireEvent.click(uninstallOf('thumbfast'));
    fireEvent.click(uninstallOf('uosc'));

    expect(screen.getAllByRole('group')).toHaveLength(1);
    expect(within(row('uosc')).getByRole('group')).toBeTruthy();
    expect(within(row('thumbfast')).queryByRole('group')).toBeNull();
    expect(uninstallOf('thumbfast').getAttribute('aria-expanded')).toBe('false');
  });

  test('the last row takes the focus to the one before it, and an empty list to the heading', async () => {
    rust({ plugins_uninstall: () => state([THUMBFAST]) });
    current = state([THUMBFAST, UOSC]);
    await open();

    fireEvent.click(uninstallOf('uosc'));
    fireEvent.click(within(row('uosc')).getByRole('button', { name: 'Confirm' }));
    await settle();

    expect(names()).toEqual(['thumbfast']);
    expect(document.activeElement).toBe(switchOf('thumbfast'));

    rust({ plugins_uninstall: () => state([]) });
    fireEvent.click(uninstallOf('thumbfast'));
    fireEvent.click(within(row('thumbfast')).getByRole('button', { name: 'Confirm' }));
    await settle();

    expect(names()).toEqual([]);
    expect(document.activeElement).toBe(heading());
  });

  test('an uninstall leaves the focus where the user put it meanwhile', async () => {
    rust({ plugins_uninstall: () => state([UOSC, COPY, RELOAD, SUB_SELECT]) });
    await open();
    fireEvent.click(uninstallOf('thumbfast'));
    fireEvent.click(within(row('thumbfast')).getByRole('button', { name: 'Confirm' }));

    // Rust is still moving the files; the user goes on to another row.
    switchOf('reload').focus();
    await settle();

    expect(names()).toEqual(['uosc', 'thumbfast.lua', 'reload', 'sub-select']);
    expect(document.activeElement).toBe(switchOf('reload'));
  });

  test('a refused uninstall keeps the row and the question, and says why', async () => {
    rust({
      plugins_uninstall: () => {
        throw { type: 'io', message: 'cannot move the files to the Recycle Bin: access denied' };
      },
    });
    await open();

    fireEvent.click(uninstallOf('uosc'));
    fireEvent.click(within(row('uosc')).getByRole('button', { name: 'Confirm' }));
    await settle();

    expect(names()).toHaveLength(5);
    expect(within(row('uosc')).getByRole('alert').textContent).toBe(
      'cannot move the files to the Recycle Bin: access denied',
    );
    // Still asking, so that it can be tried again or called off.
    expect(within(row('uosc')).getByRole('group')).toBeTruthy();
  });
});

describe('the log of a plugin that reports errors', () => {
  const LINES: LogLine[] = [
    { level: 'error', prefix: 'reload', text: 'cannot find the file\n' },
    { level: 'error', prefix: 'reload', text: 'the cache did not grow' },
  ];

  test('the errors badge opens the log', async () => {
    rust({ plugins_log: () => LINES });
    await open();
    const badge = within(row('reload')).getByRole('button', { name: 'Reports errors: 3' });

    fireEvent.click(badge, { detail: 0 });
    await settle();

    expect(sent('plugins_log')).toHaveLength(1);
    expect(sent('plugins_log')[0]?.[1]).toEqual({ name: 'reload' });
    expect(badge.getAttribute('aria-expanded')).toBe('true');
    // In the row, the lines as the details of an error card show them.
    const log = within(row('reload')).getByRole('region', { name: 'Errors of reload' });
    expect(within(log).getByText('[reload] cannot find the file')).toBeTruthy();
    expect(within(log).getByText('[reload] the cache did not grow')).toBeTruthy();
    expect(document.getElementById(badge.getAttribute('aria-controls') ?? '')).toBe(log);

    // The badge closes it again.
    fireEvent.click(badge, { detail: 0 });
    expect(within(row('reload')).queryByRole('region')).toBeNull();
    expect(badge.getAttribute('aria-expanded')).toBe('false');
  });

  test('Esc closes the log and the focus goes back to the badge', async () => {
    rust({ plugins_log: () => LINES });
    await open();
    const badge = within(row('reload')).getByRole('button', { name: 'Reports errors: 3' });
    fireEvent.click(badge, { detail: 0 });
    await settle();
    const log = within(row('reload')).getByRole('region');
    log.focus();

    expect(fireEvent.keyDown(log, { key: 'Escape' })).toBe(false);

    expect(within(row('reload')).queryByRole('region')).toBeNull();
    expect(document.activeElement).toBe(badge);
  });

  test('reads the log again when the plugin reports more while it is open', async () => {
    let lines = LINES;
    rust({ plugins_log: () => lines });
    await open();
    fireEvent.click(within(row('reload')).getByRole('button', { name: 'Reports errors: 3' }));
    await settle();
    expect(sent('plugins_log')).toHaveLength(1);

    lines = [...LINES, { level: 'error', prefix: 'reload', text: 'and once more' }];
    emit('plugins:changed', state([THUMBFAST, UOSC, COPY, { ...RELOAD, errors: 4 }, SUB_SELECT]));
    await settle();

    expect(sent('plugins_log')).toHaveLength(2);
    expect(within(row('reload')).getByText('[reload] and once more')).toBeTruthy();
  });

  test('says when nothing was written, and when the log cannot be read', async () => {
    await open();
    fireEvent.click(within(row('reload')).getByRole('button', { name: 'Reports errors: 3' }));
    await settle();
    expect(within(row('reload')).getByText('Nothing was written to the log.')).toBeTruthy();

    fireEvent.click(within(row('reload')).getByRole('button', { name: 'Reports errors: 3' }));
    rust({
      plugins_log: () => {
        throw new Error('no such plugin');
      },
    });
    fireEvent.click(within(row('reload')).getByRole('button', { name: 'Reports errors: 3' }));
    await settle();
    expect(within(row('reload')).getByText('The log could not be read.')).toBeTruthy();
  });
});

describe('the settings of a plugin', () => {
  test('the Settings button opens the settings of the plugin in its row, and closes them again', async () => {
    await open();
    const button = settingsOf('thumbfast');

    fireEvent.click(button, { detail: 1 });
    await settle();

    expect(sent('plugins_settings')).toHaveLength(1);
    expect(sent('plugins_settings')[0]?.[1]).toEqual({ name: 'thumbfast' });
    // In the row, in the flow of the page, named by the plugin.
    const panel = within(row('thumbfast')).getByRole('group', { name: 'Settings of thumbfast' });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(button.getAttribute('aria-controls') ?? '')).toBe(panel);
    expect(within(panel).getByRole('slider', { name: 'Maximum height' })).toBeTruthy();
    // Only this row.
    expect(within(row('uosc')).queryByRole('group')).toBeNull();
    expect(settingsOf('uosc').getAttribute('aria-expanded')).toBe('false');

    // The button closes it again.
    fireEvent.click(button, { detail: 1 });
    expect(within(row('thumbfast')).queryByRole('group')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBeNull();
  });

  test('a plugin without a schema is edited as keys and values', async () => {
    await open();

    fireEvent.click(settingsOf('uosc'));
    await settle();

    const panel = within(row('uosc')).getByRole('group', { name: 'Settings of uosc' });
    expect(within(panel).getByRole('textbox', { name: 'fps' })).toBeTruthy();
    expect(within(panel).getByRole('group', { name: 'New option' })).toBeTruthy();
    expect(sent('plugins_settings')[0]?.[1]).toEqual({ name: 'uosc' });
  });

  test('opened with the keyboard the focus goes into the panel; the pointer leaves it where it is', async () => {
    await open();

    fireEvent.click(settingsOf('thumbfast'), { detail: 0 });
    await settle();
    const panel = within(row('thumbfast')).getByRole('group', { name: 'Settings of thumbfast' });
    expect(document.activeElement).toBe(panel);

    fireEvent.click(settingsOf('reload'), { detail: 1 });
    await settle();
    expect(within(row('reload')).getByRole('group', { name: 'Settings of reload' })).toBeTruthy();
    expect(row('reload').contains(document.activeElement)).toBe(false);
  });

  test('Esc closes the settings and the focus goes back to the button', async () => {
    await open();
    const button = settingsOf('thumbfast');
    fireEvent.click(button, { detail: 0 });
    await settle();
    const prefix = within(row('thumbfast')).getByRole('textbox', { name: 'Prefix' });
    prefix.focus();

    // Handled, so that mpv does not get the Esc (it would leave the fullscreen).
    expect(fireEvent.keyDown(prefix, { key: 'Escape' })).toBe(false);

    expect(within(row('thumbfast')).queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  test('an Esc that a field used first leaves the settings open: the list closes, typing is dropped', async () => {
    await open();
    fireEvent.click(settingsOf('thumbfast'), { detail: 0 });
    await settle();
    const inRow = within(row('thumbfast'));
    const panel = () => inRow.queryByRole('group', { name: 'Settings of thumbfast' });

    // An open list: the first Esc closes the list, with the focus back on its button.
    const mode = inRow.getByRole('button', { name: /^Mode/ });
    fireEvent.click(mode);
    expect(inRow.getByRole('listbox')).toBeTruthy();
    expect(fireEvent.keyDown(inRow.getByRole('option', { name: 'fast' }), { key: 'Escape' })).toBe(false);
    expect(inRow.queryByRole('listbox')).toBeNull();
    expect(panel()).not.toBeNull();
    expect(document.activeElement).toBe(mode);

    // Typing that is dropped: the same.
    const prefix = inRow.getByRole('textbox', { name: 'Prefix' }) as HTMLInputElement;
    fireEvent.change(prefix, { target: { value: 'typed' } });
    expect(fireEvent.keyDown(prefix, { key: 'Escape' })).toBe(false);
    expect(prefix.value).toBe('thumb');
    expect(panel()).not.toBeNull();

    // The next Esc is the panel's.
    expect(fireEvent.keyDown(prefix, { key: 'Escape' })).toBe(false);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(settingsOf('thumbfast'));
  });

  test('the arrows belong to the fields of the settings, and still move between rows from the row’s buttons', async () => {
    await open();
    fireEvent.click(settingsOf('thumbfast'), { detail: 0 });
    await settle();
    const prefix = within(row('thumbfast')).getByRole('textbox', { name: 'Prefix' });
    prefix.focus();

    // Not the row's: the focus stays and the key is left to the field.
    expect(fireEvent.keyDown(prefix, { key: 'ArrowDown' })).toBe(true);
    expect(document.activeElement).toBe(prefix);

    const button = settingsOf('thumbfast');
    button.focus();
    expect(fireEvent.keyDown(button, { key: 'ArrowDown' })).toBe(false);
    expect(document.activeElement).toBe(switchOf('uosc'));
  });

  test('Esc in the new-option row drops the typing first, and the next Esc closes the panel', async () => {
    await open();
    fireEvent.click(settingsOf('uosc'), { detail: 0 });
    await settle();
    const name = within(row('uosc')).getByRole('textbox', { name: 'Option name' }) as HTMLInputElement;
    name.focus();
    fireEvent.change(name, { target: { value: 'volume' } });

    expect(fireEvent.keyDown(name, { key: 'Escape' })).toBe(false);
    expect(name.value).toBe('');
    expect(within(row('uosc')).getByRole('group', { name: 'Settings of uosc' })).toBeTruthy();

    // Nothing left to drop: the panel's.
    expect(fireEvent.keyDown(name, { key: 'Escape' })).toBe(false);
    expect(within(row('uosc')).queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(settingsOf('uosc'));
  });

  test('a change reaches Rust, and the apply bar is what Rust says', async () => {
    rust({
      plugins_set_setting: () => ({
        ...settingsFor('thumbfast'),
        entries: [{ key: 'prefix', value: 'x' }],
      }),
    });
    await open();
    fireEvent.click(settingsOf('thumbfast'));
    await settle();
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    const panel = within(row('thumbfast')).getByRole('group', { name: 'Settings of thumbfast' });
    expect(within(panel).getByText(/takes effect after Apply/)).toBeTruthy();

    const prefix = within(panel).getByRole('textbox', { name: 'Prefix' }) as HTMLInputElement;
    fireEvent.change(prefix, { target: { value: 'x' } });
    fireEvent.keyDown(prefix, { key: 'Enter' });
    await settle();

    expect(sent('plugins_set_setting')).toHaveLength(1);
    expect(sent('plugins_set_setting')[0]?.[1]).toEqual({
      name: 'thumbfast',
      key: 'prefix',
      value: 'x',
    });
    expect(prefix.value).toBe('x');
    // Rust marks the running plugin pending and sends the state: the bar is the page's own.
    emit('plugins:changed', state(LIST, { restartNeeded: true }));
    expect(within(applyRegion()).getByRole('button', { name: 'Apply' })).toBeTruthy();
    // The settings stay open.
    expect(within(row('thumbfast')).getByRole('group', { name: 'Settings of thumbfast' })).toBeTruthy();
  });

  test('while Apply runs the settings can be read and the fields are off', async () => {
    current = state(LIST, { applying: true });
    await open();

    fireEvent.click(settingsOf('thumbfast'));
    await settle();

    const panel = within(row('thumbfast')).getByRole('group', { name: 'Settings of thumbfast' });
    const slider = within(panel).getByRole('slider', { name: 'Maximum height' }) as HTMLInputElement;
    const prefix = within(panel).getByRole('textbox', { name: 'Prefix' }) as HTMLInputElement;
    expect(slider.disabled).toBe(true);
    expect(prefix.disabled).toBe(true);
  });
});

describe('restore essentials', () => {
  test('restore essentials shows only when one was removed', async () => {
    await open();
    expect(screen.queryByRole('button', { name: 'Restore essentials' })).toBeNull();

    emit('plugins:changed', state(LIST, { removedEssentials: ['reload'] }));

    const button = screen.getByRole('button', { name: 'Restore essentials' });
    expect(button).toBeTruthy();
    expect(screen.getByText('Brings back the essentials you removed: reload.')).toBeTruthy();

    emit('plugins:changed', state(LIST, { removedEssentials: [] }));
    expect(screen.queryByRole('button', { name: 'Restore essentials' })).toBeNull();
  });

  test('says which essentials came back', async () => {
    current = state([THUMBFAST], { removedEssentials: ['reload', 'sub-select'] });
    rust({
      plugins_restore_essentials: () => state([THUMBFAST, plugin('reload'), plugin('sub-select')]),
    });
    await open();
    expect(restoreRegion().textContent).toBe('');

    const button = screen.getByRole('button', { name: 'Restore essentials' });
    button.focus();
    fireEvent.click(button, { detail: 0 });
    await settle();

    expect(sent('plugins_restore_essentials')).toHaveLength(1);
    expect(restoreRegion().textContent).toBe('Restored: reload and sub-select.');
    // Nothing is left to bring back, and the button went; the keyboard goes on at the report.
    expect(screen.queryByRole('button', { name: 'Restore essentials' })).toBeNull();
    expect(document.activeElement).toBe(restoreRegion());
    expect(names()).toEqual(['thumbfast', 'reload', 'sub-select']);
  });

  test('says which essentials did not come back, and why: a script of the same name is in the way', async () => {
    // thumbfast.lua is the user's own: Rust drops the stale record and installs nothing, so
    // thumbfast is neither in the list nor offered any more.
    const own = plugin('thumbfast.lua', { source: 'manual', version: null, copyOf: 'thumbfast' });
    current = state([UOSC], { removedEssentials: ['thumbfast', 'reload'] });
    rust({ plugins_restore_essentials: () => state([UOSC, own, RELOAD]) });
    await open();

    fireEvent.click(screen.getByRole('button', { name: 'Restore essentials' }));
    await settle();

    const lines = Array.from(restoreRegion().querySelectorAll('p')).map((line) => line.textContent);
    expect(lines).toEqual([
      'Restored: reload.',
      'Not restored: thumbfast. A script of the same name that was added by hand is in the way. Remove or rename it, and Kaleido installs the essential at its next start.',
    ]);
    expect(screen.queryByRole('button', { name: 'Restore essentials' })).toBeNull();
  });

  test('an essential that fails to install with nothing of the user’s in the way is sent to the log', async () => {
    current = state([UOSC], { removedEssentials: ['thumbfast', 'reload'] });
    // thumbfast is neither listed nor offered, and no row is a copy of it: the install failed.
    rust({ plugins_restore_essentials: () => state([UOSC, RELOAD]) });
    await open();

    fireEvent.click(screen.getByRole('button', { name: 'Restore essentials' }));
    await settle();

    const lines = Array.from(restoreRegion().querySelectorAll('p')).map((line) => line.textContent);
    expect(lines).toEqual(['Restored: reload.', 'Could not be put back: thumbfast. The log says why.']);
    // It does not blame a script that is not there.
    expect(restoreRegion().textContent).not.toContain('added by hand');
  });

  test('a restore that changes nothing leaves no report', async () => {
    current = state([THUMBFAST], { removedEssentials: ['reload'] });
    // Rust brought nothing back and blocked nothing: reload is still offered.
    rust({ plugins_restore_essentials: () => state([THUMBFAST], { removedEssentials: ['reload'] }) });
    await open();

    fireEvent.click(screen.getByRole('button', { name: 'Restore essentials' }));
    await settle();

    expect(restoreRegion().textContent).toBe('');
    expect(screen.getByRole('button', { name: 'Restore essentials' })).toBeTruthy();
  });

  test('a refused restore says why', async () => {
    current = state(LIST, { removedEssentials: ['reload'] });
    rust({
      plugins_restore_essentials: () => {
        throw { type: 'busy' };
      },
    });
    await open();

    fireEvent.click(screen.getByRole('button', { name: 'Restore essentials' }));
    await settle();

    expect(screen.getByRole('alert').textContent).toBe('Changes wait until Apply finishes.');
    // It is still offered.
    expect(screen.getByRole('button', { name: 'Restore essentials' })).toBeTruthy();
  });
});

describe('what Rust refuses', () => {
  const refuse = (error: unknown) => {
    rust({
      plugins_set_enabled: () => {
        throw error;
      },
    });
  };

  test('a change during Apply is refused, and the row says that changes wait', async () => {
    refuse({ type: 'busy' });
    await open();

    fireEvent.click(switchOf('thumbfast'));
    await settle();

    expect(within(row('thumbfast')).getByRole('alert').textContent).toBe(
      'Changes wait until Apply finishes.',
    );
    // Nothing changed.
    expect(switchOf('thumbfast').getAttribute('aria-checked')).toBe('true');

    // Apply is done: the message is no longer true, and it goes.
    emit('plugins:changed', state(LIST));
    expect(within(row('thumbfast')).queryByRole('alert')).toBeNull();
  });

  test('a file that cannot be moved shows Rust’s message in the row', async () => {
    refuse({ type: 'io', message: 'cannot save plugins.json: access denied' });
    await open();

    fireEvent.click(switchOf('uosc'));
    await settle();

    expect(within(row('uosc')).getByRole('alert').textContent).toBe(
      'cannot save plugins.json: access denied',
    );
    expect(within(row('thumbfast')).queryByRole('alert')).toBeNull();
    // The next action clears it.
    refuse({ type: 'busy' });
    fireEvent.click(switchOf('thumbfast'));
    await settle();
    expect(within(row('uosc')).queryByRole('alert')).toBeNull();
  });

  test('a plugin that is gone says so, and the list is read again', async () => {
    refuse({ type: 'notFound', name: 'uosc' });
    await open();
    expect(sent('plugins_list')).toHaveLength(1);
    // It is gone by the time the list is read again.
    current = state([THUMBFAST, COPY, RELOAD, SUB_SELECT]);

    fireEvent.click(switchOf('uosc'));
    await settle();

    expect(sent('plugins_list')).toHaveLength(2);
    expect(names()).toEqual(['thumbfast', 'thumbfast.lua', 'reload', 'sub-select']);
    // The row it was said at is gone: the page says it.
    expect(screen.getByRole('alert').textContent).toBe(
      'The plugin uosc is gone. The list was read again.',
    );
  });
});

describe('the keyboard', () => {
  test('the arrow keys move between the rows and do not reach mpv; they come round', async () => {
    await open();
    switchOf('thumbfast').focus();

    expect(fireEvent.keyDown(switchOf('thumbfast'), { key: 'ArrowDown' })).toBe(false);
    expect(document.activeElement).toBe(switchOf('uosc'));
    fireEvent.keyDown(switchOf('uosc'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(switchOf('thumbfast.lua'));
    fireEvent.keyDown(switchOf('thumbfast.lua'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(switchOf('uosc'));

    // From the first row up to the last, and from the last down to the first.
    switchOf('thumbfast').focus();
    fireEvent.keyDown(switchOf('thumbfast'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(switchOf('sub-select'));
    fireEvent.keyDown(switchOf('sub-select'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(switchOf('thumbfast'));
    expect(fireEvent.keyDown(switchOf('thumbfast'), { key: 'ArrowUp' })).toBe(false);
  });

  test('the arrow keys work from any control of the row', async () => {
    await open();
    const ask = uninstallOf('thumbfast');
    ask.focus();

    fireEvent.keyDown(ask, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(switchOf('uosc'));
  });

  test('the arrows scroll an open log, and neither move between the rows nor reach mpv', async () => {
    rust({ plugins_log: () => [{ level: 'error', prefix: 'reload', text: 'cannot find the file' }] });
    await open();
    fireEvent.click(within(row('reload')).getByRole('button', { name: 'Reports errors: 3' }));
    await settle();
    const log = within(row('reload')).getByRole('region');
    // jsdom lays nothing out: the scroll position is a plain number here.
    Object.defineProperty(log, 'scrollTop', { value: 0, writable: true, configurable: true });
    Object.defineProperty(log, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(log, 'clientHeight', { value: 100, configurable: true });
    log.focus();

    // Handled by the log (so mpv does not seek with the arrow) ...
    expect(fireEvent.keyDown(log, { key: 'ArrowDown' })).toBe(false);
    expect(log.scrollTop).toBe(32);
    expect(fireEvent.keyDown(log, { key: 'PageDown' })).toBe(false);
    expect(log.scrollTop).toBe(132);
    fireEvent.keyDown(log, { key: 'ArrowUp' });
    expect(log.scrollTop).toBe(100);
    fireEvent.keyDown(log, { key: 'End' });
    expect(log.scrollTop).toBe(500);
    fireEvent.keyDown(log, { key: 'Home' });
    expect(log.scrollTop).toBe(0);
    // ... never above the top ...
    fireEvent.keyDown(log, { key: 'ArrowUp' });
    expect(log.scrollTop).toBe(0);
    // ... and the focus stays in the log: the row did not move on to the next one.
    expect(document.activeElement).toBe(log);
    // Other keys are not its own.
    expect(fireEvent.keyDown(log, { key: 'a' })).toBe(true);
  });

  test('the arrows trade the focus between the two buttons of the question', async () => {
    await open();
    fireEvent.click(uninstallOf('uosc'));
    const group = within(row('uosc')).getByRole('group');
    const confirm = within(group).getByRole('button', { name: 'Confirm' });
    const cancel = within(group).getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);

    expect(fireEvent.keyDown(cancel, { key: 'ArrowUp' })).toBe(false);
    expect(document.activeElement).toBe(confirm);
    expect(fireEvent.keyDown(confirm, { key: 'ArrowRight' })).toBe(false);
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(confirm);

    // Not on to the next row.
    expect(document.activeElement).not.toBe(switchOf('thumbfast.lua'));
    // Esc still closes the question from either.
    expect(fireEvent.keyDown(confirm, { key: 'Escape' })).toBe(false);
    expect(within(row('uosc')).queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(uninstallOf('uosc'));
  });

  test('Tab reaches the badge, the switch and the buttons of a row in the order they are drawn', async () => {
    await open();
    const controls = Array.from(row('reload').querySelectorAll('button')).map(
      (button) => button.getAttribute('aria-label') ?? button.textContent,
    );

    // The badge (it sits with the name, above the switch), then the switch, Settings and Uninstall.
    expect(controls).toEqual(['Reports errors: 3', '', 'Settings of reload', 'Uninstall reload']);
    expect(row('reload').querySelectorAll('[tabindex]')).toHaveLength(0);
  });

  test('Esc on a row with nothing open is left to mpv', async () => {
    await open();
    switchOf('thumbfast').focus();

    expect(fireEvent.keyDown(switchOf('thumbfast'), { key: 'Escape' })).toBe(true);
  });
});

describe('the page has no layer of its own', () => {
  beforeEach(() => {
    // Windows' animations are off: the mini player comes up in its place, with no frames to wait for.
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({ media: query, matches: query === '(prefers-reduced-motion: reduce)' })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('the page has no portal: everything renders inside the page layer', async () => {
    // Over the real shell: the page layer is clipped around the mini player (Ruling R46), so
    // whatever opens outside `main` could be drawn over the video.
    rust({ plugins_log: () => [{ level: 'error', prefix: 'reload', text: 'cannot find the file' }] });
    current = state(LIST, { restartNeeded: true, removedEssentials: ['sub-select'] });
    useUiStore.getState().setPage('plugins');
    usePlayerStore.setState({ loaded: true, props: { 'idle-active': false, pause: false } });
    const { container } = render(
      <AppShell
        home={<p>Start</p>}
        player={<p>Video</p>}
        plugins={<PluginsPage />}
        settings={<p>Options</p>}
      />,
    );
    await settle();

    // Everything the page can open: the question, the log, the settings, the apply bar, the restore button.
    fireEvent.click(uninstallOf('thumbfast'));
    fireEvent.click(within(row('reload')).getByRole('button', { name: 'Reports errors: 3' }));
    fireEvent.click(settingsOf('sub-select'));
    await settle();
    // The list of a setting opens in the page too.
    fireEvent.click(within(row('sub-select')).getByRole('button', { name: /^Mode/ }));

    const main = screen.getByRole('main');
    const opened = [
      within(row('thumbfast')).getByRole('group'),
      within(row('reload')).getByRole('region', { name: 'Errors of reload' }),
      within(row('sub-select')).getByRole('group', { name: 'Settings of sub-select' }),
      within(row('sub-select')).getByRole('listbox'),
      screen.getByRole('button', { name: 'Apply' }),
      screen.getByRole('button', { name: 'Restore essentials' }),
      ...Array.from(document.querySelectorAll('[data-plugin]')),
    ];
    for (const element of opened) expect(main.contains(element), element.outerHTML).toBe(true);
    // No popover, no portal: nothing in the document but the app's own root.
    expect(document.querySelectorAll('[popover]')).toHaveLength(0);
    expect(document.body.children).toHaveLength(1);
    expect(document.body.firstElementChild).toBe(container);
    // And the page is what the shell shows on this page, with the video in the mini player.
    expect(main.getAttribute('data-view')).toBe('plugins');
    await waitFor(() => {
      expect(main.closest('[data-page-layer]')?.getAttribute('data-mini')).toBe('true');
    });
  });
});

describe('leaving the page', () => {
  test('what the page said about its last actions goes with it', async () => {
    rust({
      plugins_set_enabled: () => {
        throw { type: 'io', message: 'access denied' };
      },
    });
    const view = await open();
    fireEvent.click(switchOf('uosc'));
    await settle();
    expect(usePluginsStore.getState().error).not.toBeNull();

    view.unmount();

    expect(usePluginsStore.getState().error).toBeNull();
    // Coming back, the page reads again.
    const before = sent('plugins_list').length;
    render(<PluginsPage />);
    await settle();
    expect(sent('plugins_list')).toHaveLength(before + 1);
    expect(screen.queryByText('access denied')).toBeNull();
  });
});
