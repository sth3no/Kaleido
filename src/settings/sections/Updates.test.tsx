import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../../i18n';
import type { Settings, ToolStatus } from '../../ipc/types';
import { DEFAULT_APPEARANCE } from '../../theme/tokens';
import { useSettingsStore } from '../store';
import Updates from './Updates';

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

const SETTINGS: Settings = {
  version: 1,
  language: 'system',
  appearance: DEFAULT_APPEARANCE,
  playback: { openWhilePlaying: 'replace', cookiesFromBrowser: null },
  updates: { ytdlpChannel: 'stable' },
};

const DIAGNOSTICS = 'Kaleido: 0.1.0\nlibmpv: mpv v0.41.0-241-gaccb7b2821\nFFmpeg: N-118000-g1234567\n';

/** A time `hours` ago, as Rust writes one (RFC 3339, UTC). */
const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3600 * 1000).toISOString();

const YT_DLP: ToolStatus = {
  tool: 'ytDlp',
  state: 'ready',
  version: '2026.08.19',
  checkedAt: hoursAgo(3),
  error: null,
};
const DENO: ToolStatus = {
  tool: 'deno',
  state: 'ready',
  version: '2.9.7',
  checkedAt: hoursAgo(48),
  error: null,
};

type Answers = Record<string, (args: unknown) => unknown>;

/** How Rust answers the commands; `answers` replaces some. */
function rust(answers: Answers = {}) {
  const all: Answers = {
    tools_status: () => [YT_DLP, DENO],
    tools_check: (args) => ({ ...YT_DLP, tool: (args as { tool: ToolStatus['tool'] }).tool }),
    system_diagnostics: () => DIAGNOSTICS,
    settings_set: () => SETTINGS,
    ...answers,
  };
  vi.mocked(invoke).mockImplementation(((command: string, args?: unknown) =>
    Promise.resolve(all[command]?.(args) ?? null)) as unknown as typeof invoke);
}

const sent = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

/** Rust sends an event. */
function emit(name: string, payload: unknown) {
  const handler = events.handlers.get(name);
  if (!handler) throw new Error(`the section does not listen to ${name}`);
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

/** The section, once the tools and the version of libmpv are in. */
async function open(answers: Answers = {}) {
  rust(answers);
  // The channel's row is drawn once Kaleido's settings are read (the page reads them).
  useSettingsStore.getState().setKaleido(SETTINGS);
  const view = render(<Updates />);
  await screen.findByText('mpv v0.41.0-241-gaccb7b2821');
  await settle();
  return view;
}

const tool = (name: 'yt-dlp' | 'Deno') => screen.getByRole('group', { name });
const checkButton = (name: 'yt-dlp' | 'Deno') =>
  within(tool(name)).getByRole('button', { name: 'Check now' }) as HTMLButtonElement;
/** The state line of a tool: what it is doing, with Rust's reason after it where it failed. */
const stateOf = (name: 'yt-dlp' | 'Deno') => within(tool(name)).getByRole('status');

/** The rows of the section, top to bottom. */
const rows = () =>
  Array.from(document.querySelectorAll('[data-tool], [data-setting], [data-fact]')).map(
    (row) => row.getAttribute('data-tool') ?? row.getAttribute('data-setting') ?? row.getAttribute('data-fact'),
  );

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  events.handlers.clear();
  vi.mocked(invoke).mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  setLanguage('en');
});

describe('the tools', () => {
  test('updates shows each tool with its version, last check and a check button', async () => {
    await open();

    expect(sent('tools_status')).toHaveLength(1);
    const ytDlp = tool('yt-dlp');
    expect(within(ytDlp).getByText('Version 2026.08.19')).toBeTruthy();
    expect(within(ytDlp).getByText('Checked 3 hours ago')).toBeTruthy();
    expect(stateOf('yt-dlp').textContent).toBe('Up to date');
    expect(checkButton('yt-dlp').getAttribute('aria-disabled')).toBe('false');

    const deno = tool('Deno');
    expect(within(deno).getByText('Version 2.9.7')).toBeTruthy();
    expect(within(deno).getByText('Checked 2 days ago')).toBeTruthy();
    expect(stateOf('Deno').textContent).toBe('Up to date');
    expect(checkButton('Deno').getAttribute('aria-disabled')).toBe('false');

    // yt-dlp, its channel, Deno, and the libmpv; the app's own channel comes with the updater (M4),
    // and nothing stands in its place.
    expect(rows()).toEqual(['ytDlp', 'updates.ytdlpChannel', 'deno', 'libmpv']);
  });

  test('a tool that is not installed says so, and has never been checked', async () => {
    await open({
      tools_status: () => [
        { tool: 'ytDlp', state: 'missing', version: null, checkedAt: null, error: null },
        DENO,
      ],
    });
    const ytDlp = tool('yt-dlp');
    expect(within(ytDlp).getByText('Not installed')).toBeTruthy();
    expect(within(ytDlp).getByText('Not checked yet')).toBeTruthy();
    expect(stateOf('yt-dlp').textContent).toBe('Not downloaded yet');
    // It can be checked, which downloads it.
    expect(checkButton('yt-dlp').getAttribute('aria-disabled')).toBe('false');
  });

  test('says what a tool is doing: checking, downloading, and a check that failed with Rust\'s reason', async () => {
    await open({
      tools_status: () => [
        { ...YT_DLP, state: 'checking' },
        { ...DENO, state: 'failed', error: 'Deno 2.1.0 is older than 2.3.0, which yt-dlp needs.' },
      ],
    });
    expect(stateOf('yt-dlp').textContent).toBe('Checking for a new version…');
    expect(stateOf('Deno').textContent).toBe(
      'Needs attention Deno 2.1.0 is older than 2.3.0, which yt-dlp needs.',
    );
    // The reason is Rust's, in English; it is marked so, for a screen reader reading Czech.
    expect(within(stateOf('Deno')).getByText(/older than 2\.3\.0/).getAttribute('lang')).toBe('en');
    // Installed, so the version is still there.
    expect(within(tool('Deno')).getByText('Version 2.9.7')).toBeTruthy();

    emit('tools:status', { ...YT_DLP, state: 'downloading' });
    expect(stateOf('yt-dlp').textContent).toBe('Downloading a new version…');
  });

  test('a failed state without a reason has no detail', async () => {
    await open({ tools_status: () => [{ ...YT_DLP, state: 'failed', error: null }, DENO] });
    expect(stateOf('yt-dlp').textContent).toBe('Needs attention');
    expect(stateOf('yt-dlp').querySelector('[lang]')).toBeNull();
  });
});

describe('Check now', () => {
  test('checks the tool, is busy until Rust has answered, and shows the answer', async () => {
    let answer: (status: ToolStatus) => void = () => undefined;
    await open({
      tools_check: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    const button = checkButton('yt-dlp');
    // Pressed from the keyboard: it has the focus.
    act(() => {
      button.focus();
    });

    fireEvent.click(button);
    expect(sent('tools_check')).toEqual([['tools_check', { tool: 'ytDlp' }]]);
    // At once, before the first event of the check: busy, and the state says what is going on.
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(stateOf('yt-dlp').textContent).toBe('Checking for a new version…');
    // Not `disabled`: that would drop the focus of a keyboard user to the page.
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    // Another press does nothing meanwhile, and the other tool is not touched.
    fireEvent.click(button);
    expect(sent('tools_check')).toHaveLength(1);
    expect(checkButton('Deno').getAttribute('aria-disabled')).toBe('false');

    await act(async () => {
      answer({ ...YT_DLP, version: '2026.10.12', checkedAt: new Date().toISOString() });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(within(tool('yt-dlp')).getByText('Version 2026.10.12')).toBeTruthy();
    });
    expect(within(tool('yt-dlp')).getByText('Checked now')).toBeTruthy();
    expect(stateOf('yt-dlp').textContent).toBe('Up to date');
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  test('Deno is checked with its own id', async () => {
    await open();
    fireEvent.click(checkButton('Deno'));
    expect(sent('tools_check')).toEqual([['tools_check', { tool: 'deno' }]]);
  });

  test('an answer that is no state is told to the console, and ends the wait without changing the row', async () => {
    await open({ tools_check: () => ({ not: 'a state' }) });
    fireEvent.click(checkButton('yt-dlp'));

    await waitFor(() => {
      expect(checkButton('yt-dlp').getAttribute('aria-disabled')).toBe('false');
    });
    expect(console.warn).toHaveBeenCalledWith(
      'tools_check did not answer with a state of ytDlp',
      { not: 'a state' },
    );
    expect(within(tool('yt-dlp')).getByText('Version 2026.08.19')).toBeTruthy();
    expect(stateOf('yt-dlp').textContent).toBe('Up to date');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a check that failed ends in the failed state with the reason', async () => {
    await open({
      tools_check: () => ({
        ...YT_DLP,
        state: 'failed',
        error: 'The download of yt-dlp.exe failed: no connection',
      }),
    });
    fireEvent.click(checkButton('yt-dlp'));
    await waitFor(() => {
      expect(stateOf('yt-dlp').textContent).toBe(
        'Needs attention The download of yt-dlp.exe failed: no connection',
      );
    });
    // The tool that is there is still shown, and can be checked again.
    expect(within(tool('yt-dlp')).getByText('Version 2026.08.19')).toBeTruthy();
    expect(checkButton('yt-dlp').getAttribute('aria-disabled')).toBe('false');
  });

  test('a check that cannot even be started is said, and the next press takes the message away', async () => {
    await open({ tools_check: () => Promise.reject('command tools_check not found') });
    fireEvent.click(checkButton('yt-dlp'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The check could not be started.');
    expect(checkButton('yt-dlp').getAttribute('aria-disabled')).toBe('false');
    expect(console.warn).toHaveBeenCalled();

    rust();
    fireEvent.click(checkButton('yt-dlp'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a button pressed with the pointer does not stay focused, so that Space goes to mpv', async () => {
    await open();
    const button = checkButton('Deno');
    act(() => {
      button.focus();
    });
    fireEvent.pointerUp(button);
    expect(document.activeElement).not.toBe(button);
  });
});

describe('what tools:status tells', () => {
  test('a check that runs in the background shows, and makes the button busy', async () => {
    await open();
    expect(checkButton('yt-dlp').getAttribute('aria-disabled')).toBe('false');

    emit('tools:status', { ...YT_DLP, state: 'checking' });
    expect(stateOf('yt-dlp').textContent).toBe('Checking for a new version…');
    expect(checkButton('yt-dlp').getAttribute('aria-disabled')).toBe('true');
    // A press while it runs does nothing.
    fireEvent.click(checkButton('yt-dlp'));
    expect(sent('tools_check')).toEqual([]);

    emit('tools:status', { ...YT_DLP, state: 'downloading' });
    expect(checkButton('yt-dlp').getAttribute('aria-disabled')).toBe('true');

    emit('tools:status', { ...YT_DLP, version: '2026.10.12', checkedAt: new Date().toISOString() });
    expect(within(tool('yt-dlp')).getByText('Version 2026.10.12')).toBeTruthy();
    expect(stateOf('yt-dlp').textContent).toBe('Up to date');
    expect(checkButton('yt-dlp').getAttribute('aria-disabled')).toBe('false');
    // The other tool did not change.
    expect(within(tool('Deno')).getByText('Version 2.9.7')).toBeTruthy();
  });

  test('listens before it reads, and an event that comes while the read is out is not undone by it', async () => {
    let answerStatus: (list: ToolStatus[]) => void = () => undefined;
    rust({
      tools_status: () =>
        new Promise((resolve) => {
          answerStatus = resolve;
        }),
    });
    useSettingsStore.getState().setKaleido(SETTINGS);
    render(<Updates />);
    expect(events.handlers.has('tools:status')).toBe(true);
    // Both rows wait for the read.
    expect(within(tool('yt-dlp')).getByRole('status').textContent).toBe('Loading…');
    expect(within(tool('Deno')).getByRole('status').textContent).toBe('Loading…');

    // yt-dlp starts to download while the read is on its way; the read saw the state before that.
    emit('tools:status', { ...YT_DLP, state: 'downloading' });
    await act(async () => {
      answerStatus([{ ...YT_DLP, version: '2026.01.01' }, DENO]);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(within(tool('Deno')).getByText('Version 2.9.7')).toBeTruthy();
    });
    expect(stateOf('yt-dlp').textContent).toBe('Downloading a new version…');
    expect(within(tool('yt-dlp')).getByText('Version 2026.08.19')).toBeTruthy();
    expect(within(tool('yt-dlp')).queryByText('Version 2026.01.01')).toBeNull();
  });

  test('a state that cannot be read is said at each tool, and can be read again', async () => {
    rust({ tools_status: () => Promise.reject('no tools') });
    useSettingsStore.getState().setKaleido(SETTINGS);
    render(<Updates />);

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((alert) => alert.textContent)).toEqual([
      'The state of this tool could not be read.',
      'The state of this tool could not be read.',
    ]);
    // No version is made up, and there is nothing to check yet.
    expect(screen.queryByText(/^Version /)).toBeNull();
    expect(within(tool('yt-dlp')).queryByRole('button', { name: 'Check now' })).toBeNull();

    rust();
    fireEvent.click(within(tool('yt-dlp')).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Version 2026.08.19')).toBeTruthy();
    expect(within(tool('Deno')).getByText('Version 2.9.7')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sent('tools_status')).toHaveLength(2);
  });

  test('an answer that is no list is a failure too', async () => {
    rust({ tools_status: () => ({ not: 'a list' }) });
    useSettingsStore.getState().setKaleido(SETTINGS);
    render(<Updates />);
    expect((await screen.findAllByRole('alert')).length).toBe(2);
  });
});

describe('the channel', () => {
  const picker = () => screen.getByRole('button', { name: /^yt-dlp release channel/ }) as HTMLButtonElement;

  test('the channel switch saves updates.ytdlpChannel', async () => {
    await open({
      settings_set: () => ({ ...SETTINGS, updates: { ytdlpChannel: 'nightly' } }),
    });
    expect(picker().textContent).toBe('Stable');

    fireEvent.click(picker());
    fireEvent.click(screen.getByRole('option', { name: 'Nightly' }));

    // Only the changed setting goes, as a patch.
    expect(sent('settings_set')).toEqual([['settings_set', { patch: { updates: { ytdlpChannel: 'nightly' } } }]]);
    expect(sent('settings_set_mpv')).toEqual([]);
    await waitFor(() => {
      expect(useSettingsStore.getState().kaleido?.updates.ytdlpChannel).toBe('nightly');
    });
    expect(picker().textContent).toBe('Nightly');
  });

  test('says why one would choose nightly, and that Deno has only its stable releases', async () => {
    await open();
    const hint = screen.getByText(/Nightly gets yt-dlp’s fixes for websites sooner/);
    expect(hint.textContent).toContain('Deno always follows its stable releases');
    expect((picker().getAttribute('aria-describedby') ?? '').split(' ')).toContain(hint.id);
    // The channel is yt-dlp's: the Deno row has no choice of its own.
    expect(within(tool('Deno')).queryByRole('button', { name: /channel/ })).toBeNull();
  });

  test('a channel Rust refuses goes back, with the reason at the row', async () => {
    await open({ settings_set: () => Promise.reject({ type: 'io', message: 'disk full' }) });
    fireEvent.click(picker());
    fireEvent.click(screen.getByRole('option', { name: 'Nightly' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The setting could not be saved. Check that the settings folder can be written to.',
    );
    expect(picker().textContent).toBe('Stable');
  });

  test('the row is not drawn before Kaleido\'s settings are read, but the tools are', async () => {
    rust();
    render(<Updates />);
    expect(await screen.findByText('Version 2026.08.19')).toBeTruthy();
    expect(rows()).toEqual(['ytDlp', 'deno', 'libmpv']);
    expect(screen.queryByRole('button', { name: /^yt-dlp release channel/ })).toBeNull();
  });
});

describe('libmpv', () => {
  test('shows the version About shows', async () => {
    await open();
    const libmpv = screen.getByRole('group', { name: 'libmpv' });
    expect(within(libmpv).getByText('mpv v0.41.0-241-gaccb7b2821')).toBeTruthy();
    expect(sent('system_diagnostics')).toHaveLength(1);
    // It is not a tool Kaleido updates: no button.
    expect(within(libmpv).queryByRole('button')).toBeNull();
  });

  test('says it is loading until the diagnostics are in, and unknown when they cannot be read', async () => {
    let answer: (text: string) => void = () => undefined;
    rust({
      system_diagnostics: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    useSettingsStore.getState().setKaleido(SETTINGS);
    render(<Updates />);
    const libmpv = screen.getByRole('group', { name: 'libmpv' });
    expect(within(libmpv).getByText('Loading…')).toBeTruthy();
    await act(async () => {
      answer('Kaleido: 0.1.0\nlibmpv: unknown\nFFmpeg: unknown\n');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(within(libmpv).getByText('Unknown')).toBeTruthy();
    });
  });

  test('a diagnostics that cannot be read leaves it unknown, and the rest of the section works', async () => {
    rust({ system_diagnostics: () => Promise.reject('the player is not running') });
    useSettingsStore.getState().setKaleido(SETTINGS);
    render(<Updates />);
    await waitFor(() => {
      expect(within(screen.getByRole('group', { name: 'libmpv' })).getByText('Unknown')).toBeTruthy();
    });
    expect(await screen.findByText('Version 2026.08.19')).toBeTruthy();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('in Czech', () => {
  test('the texts and the time are in Czech', async () => {
    setLanguage('cs');
    rust();
    useSettingsStore.getState().setKaleido(SETTINGS);
    render(<Updates />);
    await screen.findByText('Verze 2026.08.19');
    await settle();

    const ytDlp = screen.getByRole('group', { name: 'yt-dlp' });
    expect(within(ytDlp).getByRole('status').textContent).toBe('Aktuální');
    expect(within(ytDlp).getByRole('button', { name: 'Zkontrolovat teď' })).toBeTruthy();
    // Intl tells the time in the language: "před 3 hodinami".
    const checked = within(ytDlp).getByText(/^Zkontrolováno /);
    expect(checked.textContent).toContain('před');
    expect(screen.getByRole('button', { name: /^Kanál yt-dlp/ })).toBeTruthy();
  });
});
