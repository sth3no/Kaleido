import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../../i18n';
import type { Browser, Settings, StreamError } from '../../ipc/types';
import { useSettingsStore } from '../../settings/store';
import { MAX_NOTICES, NOTICE_MS, useNoticeStore } from '../../state/noticeStore';
import { usePlayerStore } from '../../state/playerStore';
import { useUiStore } from '../../state/uiStore';
import { DEFAULT_APPEARANCE } from '../../theme/tokens';
import ErrorCards from './ErrorCards';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
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

const LINK = 'https://www.youtube.com/watch?v=abc';
const FORK_SPEC = 'firefox:abc123.default-release';

const BROWSERS: Browser[] = [
  { id: 'firefox', label: 'Firefox', spec: 'firefox', warning: null },
  { id: 'edge', label: 'Microsoft Edge', spec: 'edge', warning: 'chromiumCookies' },
  { id: 'librewolf', label: 'LibreWolf', spec: FORK_SPEC, warning: null },
  { id: 'zen', label: 'Zen', spec: '', warning: 'noProfile' },
];

const SETTINGS: Settings = {
  version: 1,
  language: 'system',
  appearance: DEFAULT_APPEARANCE,
  playback: { openWhilePlaying: 'replace', cookiesFromBrowser: null },
  updates: { ytdlpChannel: 'stable' },
};

/** The settings as Rust answers `settings_set` with the patch applied. */
const withCookies = (cookiesFromBrowser: string | null): Settings => ({
  ...SETTINGS,
  playback: { ...SETTINGS.playback, cookiesFromBrowser },
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
    system_browsers: () => BROWSERS,
    settings_set: () => withCookies(FORK_SPEC),
    stream_retry: () => null,
    ...answers,
  };
  vi.mocked(invoke).mockImplementation((async (command: string, args?: unknown) =>
    all[command]?.(args) ?? null) as unknown as typeof invoke);
}

const sent = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

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

/** `player:end-file` for a link that failed for a reason Rust knows (or does not: `null`). */
const failsLink = (streamError: StreamError | null, over: { continues?: boolean; file?: string } = {}) => {
  act(() => {
    usePlayerStore.getState().endFile({
      reason: 'error',
      error: 'loading failed',
      file: over.file ?? LINK,
      continues: over.continues ?? false,
      streamError,
    });
  });
};

/** A file that cannot be played: no class, no action. */
const failsFile = (file: string) => {
  act(() => {
    usePlayerStore.getState().endFile({
      reason: 'error',
      error: 'loading failed',
      file,
      continues: false,
      streamError: null,
    });
  });
};

const button = (card: HTMLElement, name: string) => within(card).getByRole('button', { name });
const OPEN_CHOOSER = 'Use cookies from a browser';

/** The names of a card's buttons, top to bottom. */
const buttonNames = (card: HTMLElement) =>
  within(card)
    .getAllByRole('button')
    .map((control) => control.getAttribute('aria-label') ?? control.textContent);

/** The card of a link that wants cookies, with its chooser open and the browsers listed. */
async function openChooser(streamError: StreamError = 'signIn') {
  failsLink(streamError);
  fireEvent.click(button(cards()[0], OPEN_CHOOSER));
  await settle();
  return cards()[0];
}

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: FAKE });
  vi.mocked(invoke).mockReset();
  rust();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  useNoticeStore.setState(useNoticeStore.getInitialState(), true);
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(console.warn).mockRestore();
  setLanguage('en');
});

describe('what a link that did not play says and offers (spec 10.3)', () => {
  const TABLE: [error: StreamError, sentence: string, action: string | null][] = [
    ['outdated', 'yt-dlp no longer understands this website. A newer yt-dlp may.', 'Update and try again'],
    [
      'missing',
      'yt-dlp, the tool that reads web links, is not installed yet or could not be downloaded.',
      'Update and try again',
    ],
    ['signIn', 'This website requires you to sign in.', OPEN_CHOOSER],
    [
      'ageRestricted',
      'This video is age-restricted, and the website requires you to sign in to watch it.',
      OPEN_CHOOSER,
    ],
    ['cookies', 'The cookies of the chosen browser could not be read.', OPEN_CHOOSER],
    ['geoBlocked', 'This video is not available in your region.', null],
    ['private', 'This video is private.', null],
    ['removed', 'This video was removed or no longer exists.', null],
    ['network', 'yt-dlp could not reach the website. Check your internet connection.', 'Try again'],
  ];

  test.each(TABLE)('each stream error class has its text and its action: %s says "%s" and offers %s', (streamError, sentence, action) => {
    render(<ErrorCards />);

    failsLink(streamError);

    const [card] = cards();
    // The class's own sentence, read out with the failure, in place of mpv's word for the error.
    expect(within(card).getByText(sentence).closest('[role="alert"]')).not.toBeNull();
    expect(within(card).queryByText(/could not be opened/)).toBeNull();
    expect(within(card).getByText('Cannot play www.youtube.com')).toBeTruthy();
    // Close, the action of its class if it has one, Open file (nothing follows), Details.
    expect(buttonNames(card)).toEqual(['Close', ...(action === null ? [] : [action]), 'Open file', 'Details']);
  });

  test('a link that failed for no reason Rust knows is a plain card: mpv\'s word, no action', () => {
    render(<ErrorCards />);

    failsLink(null);

    const [card] = cards();
    expect(within(card).getByText(/could not be opened/)).toBeTruthy();
    expect(buttonNames(card)).toEqual(['Close', 'Open file', 'Details']);
    expect(useNoticeStore.getState().notices[0]).toMatchObject({ stream: null, url: null });
  });

  test('a link keeps its address for the action, a file has none', () => {
    render(<ErrorCards />);

    failsLink('network');
    failsFile('C:\\Videa\\a.mkv');

    expect(useNoticeStore.getState().notices[1]).toMatchObject({ stream: 'network', url: LINK, retry: 'idle' });
    expect(useNoticeStore.getState().notices[0]).toMatchObject({ stream: null, url: null });
  });

  test('"Playback continues" is said as for any file, and Open file is not offered then', () => {
    render(<ErrorCards />);

    failsLink('network', { continues: true });

    const [card] = cards();
    expect(within(card).getByText('Playback continues with the next file.')).toBeTruthy();
    expect(buttonNames(card)).toEqual(['Close', 'Try again', 'Details']);
  });

  test('the details stay: mpv\'s word and the log', () => {
    render(<ErrorCards />);
    act(() => {
      usePlayerStore.getState().addLog({ level: 'error', prefix: 'ytdl_hook', text: 'ERROR: Sign in to confirm' });
    });
    failsLink('signIn');

    fireEvent.click(button(cards()[0], 'Details'));

    expect(screen.getByText('[mpv] loading failed')).toBeTruthy();
    expect(screen.getByText('[ytdl_hook] ERROR: Sign in to confirm')).toBeTruthy();
  });

  test('the card is in the language of the app', () => {
    render(<ErrorCards />);
    failsLink('outdated');

    act(() => {
      setLanguage('cs');
    });

    const [card] = cards();
    expect(within(card).getByText('yt-dlp už tomuto webu nerozumí. Novější yt-dlp by mohl.')).toBeTruthy();
    expect(button(card, 'Aktualizovat a zkusit znovu')).toBeTruthy();
  });
});

describe('geo, private and removed only explain', () => {
  test.each(['geoBlocked', 'private', 'removed'] as const)('geo, private and removed only explain (%s): Close and Details, nothing to press', (error) => {
    render(<ErrorCards />);

    failsLink(error, { continues: true });

    const [card] = cards();
    expect(buttonNames(card)).toEqual(['Close', 'Details']);
    // Not even a hidden line for an action that is not there.
    expect(within(card).queryByRole('status')).toBeNull();
    expect(sent('stream_retry')).toEqual([]);
    expect(sent('settings_set')).toEqual([]);
  });
});

describe('update and try again', () => {
  test.each(['outdated', 'missing'] as const)(
    'update and retry calls Rust with update and shows progress (%s)',
    async (error) => {
      const answer = deferred<null>();
      rust({ stream_retry: () => answer.promise });
      render(<ErrorCards />);
      failsLink(error);
      const [card] = cards();
      const update = button(card, 'Update and try again');
      expect(update.getAttribute('aria-disabled')).toBe('false');
      expect(update.getAttribute('aria-busy')).toBeNull();
      expect(update.querySelector('span[aria-hidden="true"]')).toBeNull();

      fireEvent.click(update);
      await settle();

      // Rust is asked for the link of the card, with the update.
      expect(sent('stream_retry')).toEqual([['stream_retry', { url: LINK, update: true }]]);
      // While it runs: the button shows a ring and does nothing twice, and a line says what runs.
      expect(update.getAttribute('aria-disabled')).toBe('true');
      expect(update.getAttribute('aria-busy')).toBe('true');
      expect(update.querySelector('span[aria-hidden="true"]')).not.toBeNull();
      expect(within(card).getByRole('status').textContent).toBe('Updating yt-dlp, then trying again…');
      expect(card.textContent).toContain('Updating yt-dlp, then trying again…');
      fireEvent.click(update);
      await settle();
      expect(sent('stream_retry')).toHaveLength(1);

      // The card does not go while the update downloads, however long it takes.
      advance(NOTICE_MS * 3);
      expect(cards()).toHaveLength(1);

      // Rust has handed the link to the player: the card goes.
      answer.resolve(null);
      await settle();
      expect(cards()).toHaveLength(0);
    },
  );

  test('a new failure after the retry is a new card', async () => {
    render(<ErrorCards />);
    failsLink('outdated');

    fireEvent.click(button(cards()[0], 'Update and try again'));
    await settle();
    expect(cards()).toHaveLength(0);

    failsLink('outdated');
    expect(cards()).toHaveLength(1);
    expect(button(cards()[0], 'Update and try again').getAttribute('aria-disabled')).toBe('false');
  });

  test('Rust refusing the retry is said in the card, which stays and offers the action again', async () => {
    rust({
      stream_retry: () => {
        throw { source: LINK, kind: 'invalid' };
      },
    });
    render(<ErrorCards />);
    failsLink('outdated');
    const [card] = cards();

    fireEvent.click(button(card, 'Update and try again'));
    await settle();

    expect(cards()).toHaveLength(1);
    const refused = within(card).getByText('The link could not be opened again.');
    expect(refused.getAttribute('role')).toBe('alert');
    expect(button(card, 'Update and try again').getAttribute('aria-disabled')).toBe('false');
    expect(button(card, 'Update and try again').getAttribute('aria-busy')).toBeNull();
    expect(within(card).getByRole('status').textContent).toBe('');
    // The refusal is logged for the log, not only said in the card.
    expect(console.warn).toHaveBeenCalledWith('cannot try the link again', expect.anything());

    // Rust takes it the second time: the card goes, and its complaint with it.
    rust();
    fireEvent.click(button(card, 'Update and try again'));
    await settle();
    expect(sent('stream_retry')).toHaveLength(2);
    expect(cards()).toHaveLength(0);
  });
});

describe('try again', () => {
  test('a failed network opens the link again, without an update', async () => {
    render(<ErrorCards />);
    failsLink('network');

    fireEvent.click(button(cards()[0], 'Try again'));
    await settle();

    expect(sent('stream_retry')).toEqual([['stream_retry', { url: LINK, update: false }]]);
    expect(cards()).toHaveLength(0);
  });

  test('says what runs while it does', async () => {
    const answer = deferred<null>();
    rust({ stream_retry: () => answer.promise });
    render(<ErrorCards />);
    failsLink('network');
    const [card] = cards();

    fireEvent.click(button(card, 'Try again'));
    await settle();

    expect(within(card).getByRole('status').textContent).toBe('Trying again…');
    answer.resolve(null);
    await settle();
  });

  test('when the card holds the focus and the link is taken, the focus goes back to where it came from', async () => {
    render(
      <>
        <button type="button">Outside</button>
        <ErrorCards />
      </>,
    );
    const outside = screen.getByRole('button', { name: 'Outside' });
    failsLink('network');
    outside.focus();
    const retry = button(cards()[0], 'Try again');
    act(() => {
      retry.focus();
    });

    fireEvent.click(retry);
    await settle();

    expect(cards()).toHaveLength(0);
    expect(document.activeElement).toBe(outside);
  });
});

describe('use cookies from a browser', () => {
  test('cookies opens the browser chooser inside the card', async () => {
    render(<ErrorCards />);
    failsLink('signIn');
    const [card] = cards();
    const opener = button(card, OPEN_CHOOSER);
    expect(within(card).queryByRole('radiogroup')).toBeNull();
    expect(opener.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(opener);
    await settle();

    // Inside the card (there is no layer of its own), with the browsers Rust found.
    const group = within(card).getByRole('radiogroup', { name: 'Take cookies from' });
    expect(within(group).getAllByRole('radio').map((row) => row.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'false',
      'false',
    ]);
    expect(within(group).getByRole('radio', { name: 'LibreWolf' })).toBeTruthy();
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(opener.getAttribute('aria-controls') ?? '')?.contains(group)).toBe(true);
    // Nothing is sent before the user has chosen.
    expect(sent('settings_set')).toEqual([]);
    expect(sent('stream_retry')).toEqual([]);
  });

  test('the same button closes the chooser again', async () => {
    render(<ErrorCards />);
    const card = await openChooser();

    fireEvent.click(button(card, OPEN_CHOOSER));

    expect(within(card).queryByRole('radiogroup')).toBeNull();
    expect(button(card, OPEN_CHOOSER).getAttribute('aria-expanded')).toBe('false');
  });

  test('opened with the keyboard it takes the focus, with the pointer it does not', async () => {
    render(<ErrorCards />);
    failsLink('signIn');
    const [card] = cards();

    // A click with no pointer behind it (detail 0) is Enter or Space.
    fireEvent.click(button(card, OPEN_CHOOSER), { detail: 0 });
    await settle();
    expect(document.activeElement).toBe(within(card).getByRole('radio', { name: 'Firefox' }));

    fireEvent.click(button(card, OPEN_CHOOSER), { detail: 1 });
    act(() => {
      (document.activeElement as HTMLElement).blur();
    });
    fireEvent.click(button(card, OPEN_CHOOSER), { detail: 1 });
    await settle();
    expect(within(card).getByRole('radiogroup')).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  test('choosing a browser saves it and retries', async () => {
    const order: string[] = [];
    rust({
      settings_set: () => {
        order.push('settings_set');
        return withCookies(FORK_SPEC);
      },
      stream_retry: () => {
        order.push('stream_retry');
        return null;
      },
    });
    render(<ErrorCards />);
    const card = await openChooser();

    fireEvent.click(within(card).getByRole('radio', { name: 'LibreWolf' }));
    fireEvent.click(button(card, 'Use and try again'));
    await settle();

    // A patch with that one setting, never the whole of the settings; then the link without an update.
    expect(sent('settings_set')).toEqual([
      ['settings_set', { patch: { playback: { cookiesFromBrowser: FORK_SPEC } } }],
    ]);
    expect(sent('stream_retry')).toEqual([['stream_retry', { url: LINK, update: false }]]);
    expect(order).toEqual(['settings_set', 'stream_retry']);
    expect(cards()).toHaveLength(0);
    // The settings page, if it is open, shows what Rust confirmed.
    expect(useSettingsStore.getState().kaleido?.playback.cookiesFromBrowser).toBe(FORK_SPEC);
  });

  test('where the cookies cannot be read, "Do not use cookies" saves null and retries', async () => {
    rust({ settings_set: () => withCookies(null) });
    render(<ErrorCards />);
    const card = await openChooser('cookies');

    fireEvent.click(within(card).getByRole('radio', { name: 'Do not use cookies' }));
    fireEvent.click(button(card, 'Use and try again'));
    await settle();

    expect(sent('settings_set')).toEqual([
      ['settings_set', { patch: { playback: { cookiesFromBrowser: null } } }],
    ]);
    expect(sent('stream_retry')).toEqual([['stream_retry', { url: LINK, update: false }]]);
    expect(cards()).toHaveLength(0);
  });

  test.each(['signIn', 'ageRestricted'] as const)(
    'a login or an age (%s) does not offer "Do not use cookies": there was no choice to take back',
    async (error) => {
      render(<ErrorCards />);

      const card = await openChooser(error);

      expect(within(card).queryByRole('radio', { name: 'Do not use cookies' })).toBeNull();
      expect(within(card).getAllByRole('radio')).toHaveLength(BROWSERS.length);
    },
  );

  test('a browser without a profile is shown with its sentence and is never saved', async () => {
    render(<ErrorCards />);
    const card = await openChooser();

    const zen = within(card).getByRole('radio', { name: 'Zen' });
    expect(zen.getAttribute('aria-disabled')).toBe('true');
    expect(within(card).getByText('No profile with cookies was found.')).toBeTruthy();
    fireEvent.click(zen);
    fireEvent.click(button(card, 'Use and try again'));
    await settle();

    expect(sent('settings_set')).toEqual([]);
    expect(sent('stream_retry')).toEqual([]);
  });

  test('a Chromium browser is listed with the warning, under its name', async () => {
    render(<ErrorCards />);
    const card = await openChooser();

    const edge = within(card).getByRole('radio', { name: 'Microsoft Edge' });
    const note = document.getElementById(edge.getAttribute('aria-describedby') ?? '');
    expect(note?.textContent).toMatch(/cannot read the cookies of browsers based on Chromium/);
  });

  test('while the choice is saved the card shows the progress and stays', async () => {
    const saving = deferred<Settings>();
    rust({ settings_set: () => saving.promise });
    render(<ErrorCards />);
    const card = await openChooser();
    fireEvent.click(within(card).getByRole('radio', { name: 'Firefox' }));

    fireEvent.click(button(card, 'Use and try again'));
    await settle();

    expect(within(card).getAllByRole('status').map((region) => region.textContent)).toContain(
      'Saving the choice, then trying again…',
    );
    expect(button(card, OPEN_CHOOSER).getAttribute('aria-busy')).toBe('true');
    expect(button(card, 'Use and try again').getAttribute('aria-disabled')).toBe('true');
    // Pressed again, it does nothing twice.
    fireEvent.click(button(card, 'Use and try again'));
    await settle();
    expect(sent('settings_set')).toHaveLength(1);
    advance(NOTICE_MS * 3);
    expect(cards()).toHaveLength(1);

    saving.resolve(withCookies('firefox'));
    await settle();
    expect(sent('stream_retry')).toHaveLength(1);
    expect(cards()).toHaveLength(0);
  });

  test('a choice that cannot be saved stops there: the link is not tried, and the card says so', async () => {
    rust({
      settings_set: () => {
        throw { type: 'io', message: 'disk full' };
      },
    });
    render(<ErrorCards />);
    const card = await openChooser();
    fireEvent.click(within(card).getByRole('radio', { name: 'Firefox' }));

    fireEvent.click(button(card, 'Use and try again'));
    await settle();

    expect(sent('stream_retry')).toEqual([]);
    expect(cards()).toHaveLength(1);
    const unsaved = within(card).getByText('The choice could not be saved, so nothing was changed. Try again.');
    expect(unsaved.getAttribute('role')).toBe('alert');
    // The chooser is still there, with the choice, and can be used again.
    expect(within(card).getByRole('radio', { name: 'Firefox' }).getAttribute('aria-checked')).toBe('true');
    expect(button(card, 'Use and try again').getAttribute('aria-disabled')).toBe('false');
    expect(useSettingsStore.getState().kaleido).toBeNull();

    rust();
    fireEvent.click(button(card, 'Use and try again'));
    await settle();
    expect(sent('stream_retry')).toHaveLength(1);
    expect(cards()).toHaveLength(0);
  });

  test('a saved choice whose retry Rust refuses is said in the card', async () => {
    rust({
      stream_retry: () => {
        throw { source: LINK, kind: 'invalid' };
      },
    });
    render(<ErrorCards />);
    const card = await openChooser();
    fireEvent.click(within(card).getByRole('radio', { name: 'Firefox' }));

    fireEvent.click(button(card, 'Use and try again'));
    await settle();

    expect(cards()).toHaveLength(1);
    expect(within(card).getByText('The link could not be opened again.')).toBeTruthy();
    expect(sent('settings_set')).toHaveLength(1);
  });

  test('no browser found: a sentence and the way to Settings → Playback, from the card', async () => {
    rust({ system_browsers: () => [] });
    render(<ErrorCards />);
    const card = await openChooser();

    expect(within(card).getByText('No browser was found whose cookies can be used.')).toBeTruthy();
    fireEvent.click(button(card, 'Settings → Playback'));

    expect(useUiStore.getState().page).toBe('settings');
  });
});

describe('Esc', () => {
  const escape = (target: HTMLElement) => !fireEvent.keyDown(target, { key: 'Escape' });

  test('closes the chooser first, and then the card', async () => {
    render(<ErrorCards />);
    const card = await openChooser();
    const firefox = within(card).getByRole('radio', { name: 'Firefox' });
    expect(document.activeElement).toBe(firefox);

    // The key is the card's: it does not go on to mpv.
    expect(escape(firefox)).toBe(true);

    expect(cards()).toHaveLength(1);
    expect(within(card).queryByRole('radiogroup')).toBeNull();
    // The focus goes back to the button that opened the chooser.
    expect(document.activeElement).toBe(button(card, OPEN_CHOOSER));

    expect(escape(document.activeElement as HTMLElement)).toBe(true);
    expect(cards()).toHaveLength(0);
  });

  test('closes the chooser when the focus is elsewhere in the card, and leaves the focus where it is', async () => {
    render(<ErrorCards />);
    const card = await openChooser();
    const details = button(card, 'Details');
    act(() => {
      details.focus();
    });

    expect(escape(details)).toBe(true);

    expect(cards()).toHaveLength(1);
    expect(within(card).queryByRole('radiogroup')).toBeNull();
    expect(document.activeElement).toBe(details);
    expect(details.getAttribute('aria-expanded')).toBe('false');
  });

  test('closes the card as before when no chooser is open', () => {
    render(<ErrorCards />);
    failsLink('network');

    expect(escape(button(cards()[0], 'Try again'))).toBe(true);

    expect(cards()).toHaveLength(0);
  });

  test('a card whose chooser was closed is a plain card again: it goes by itself after 8 s', async () => {
    render(<ErrorCards />);
    const card = await openChooser();
    escape(within(card).getByRole('radio', { name: 'Firefox' }));
    act(() => {
      (document.activeElement as HTMLElement).blur();
    });

    advance(NOTICE_MS - 1);
    expect(cards()).toHaveLength(1);
    advance(1);
    expect(cards()).toHaveLength(0);
  });
});

describe('time', () => {
  test('a link\'s card goes after 8 seconds like any other', () => {
    render(<ErrorCards />);
    failsLink('network');

    advance(NOTICE_MS - 1);
    expect(cards()).toHaveLength(1);
    advance(1);
    expect(cards()).toHaveLength(0);
  });

  test('a card with an action in progress does not go away, and has its 8 seconds when the action ends', async () => {
    const answer = deferred<null>();
    rust({ stream_retry: () => answer.promise });
    render(<ErrorCards />);
    failsLink('outdated');

    fireEvent.click(button(cards()[0], 'Update and try again'));
    await settle();
    advance(NOTICE_MS * 3);
    expect(cards()).toHaveLength(1);

    // Rust refuses: the card stays, and the 8 seconds start over.
    answer.reject({ source: LINK, kind: 'invalid' });
    await settle();
    expect(cards()).toHaveLength(1);
    advance(NOTICE_MS - 1);
    expect(cards()).toHaveLength(1);
    advance(1);
    expect(cards()).toHaveLength(0);
  });

  test('a card under the pointer does not go away, and the 8 seconds start again when the pointer leaves', () => {
    render(<ErrorCards />);
    failsLink('network');
    const [card] = cards();

    fireEvent.pointerEnter(card);
    advance(NOTICE_MS * 3);
    expect(cards()).toHaveLength(1);

    fireEvent.pointerLeave(card);
    advance(NOTICE_MS - 1);
    expect(cards()).toHaveLength(1);
    advance(1);
    expect(cards()).toHaveLength(0);
  });

  test('a card with the focus inside does not go away, and the 8 seconds start again when it leaves', () => {
    render(<ErrorCards />);
    failsLink('network');
    const retry = button(cards()[0], 'Try again');

    act(() => {
      retry.focus();
    });
    advance(NOTICE_MS * 3);
    expect(cards()).toHaveLength(1);

    act(() => {
      retry.blur();
    });
    advance(NOTICE_MS);
    expect(cards()).toHaveLength(0);
  });

  test('a card with its chooser open does not go away, even when the pointer and the focus are elsewhere', async () => {
    render(<ErrorCards />);
    failsLink('signIn');
    const [card] = cards();

    // Opened with the pointer: no focus goes in, and the pointer is not over the card.
    fireEvent.click(button(card, OPEN_CHOOSER), { detail: 1 });
    await settle();
    expect(within(card).getByRole('radiogroup')).toBeTruthy();
    advance(NOTICE_MS * 3);
    expect(cards()).toHaveLength(1);

    // Closed again: the 8 seconds start over.
    fireEvent.click(button(card, OPEN_CHOOSER), { detail: 1 });
    advance(NOTICE_MS - 1);
    expect(cards()).toHaveLength(1);
    advance(1);
    expect(cards()).toHaveLength(0);
  });

  test('a card with an action in progress or the pointer over it does not go away', async () => {
    const answer = deferred<null>();
    rust({ stream_retry: () => answer.promise });
    render(<ErrorCards />);
    failsLink('network');
    failsLink('outdated', { file: 'https://example.org/video' });
    const [updating, waiting] = cards();

    // The newest card runs its action, the older one has the pointer over it.
    fireEvent.click(button(updating, 'Update and try again'));
    await settle();
    fireEvent.pointerEnter(waiting);
    advance(NOTICE_MS * 3);

    expect(cards()).toHaveLength(2);
    answer.resolve(null);
    await settle();
    // The link is taken: that card is gone. The other is still under the pointer.
    expect(cards()).toHaveLength(1);
    advance(NOTICE_MS * 3);
    expect(cards()).toHaveLength(1);
  });

  test('a fourth card does not push out the link whose action runs', async () => {
    const answer = deferred<null>();
    rust({ stream_retry: () => answer.promise });
    render(<ErrorCards />);
    failsLink('network');
    fireEvent.click(button(cards()[0], 'Try again'));
    await settle();
    failsFile('b.mkv');
    failsFile('c.mkv');
    expect(MAX_NOTICES).toBe(3);
    expect(cards()).toHaveLength(3);

    failsFile('d.mkv');

    // The oldest card that is not at work goes: b.mkv.
    expect(cards()).toHaveLength(3);
    const titles = cards().map((item) => within(item).getByText(/^Cannot play /).textContent);
    expect(titles).toEqual(['Cannot play d.mkv', 'Cannot play c.mkv', 'Cannot play www.youtube.com']);
    expect(button(cards()[2], 'Try again').getAttribute('aria-busy')).toBe('true');

    answer.resolve(null);
    await settle();
  });
});

describe('the live region', () => {
  test('a card with an action has one that is empty until the action runs, a card without one has none', async () => {
    const answer = deferred<null>();
    rust({ stream_retry: () => answer.promise });
    render(<ErrorCards />);
    failsLink('network');
    failsLink('private', { file: 'https://example.org/video' });
    const [explained, retrying] = cards();
    expect(within(explained).queryByRole('status')).toBeNull();
    const status = within(retrying).getByRole('status');
    expect(status.textContent).toBe('');

    fireEvent.click(button(retrying, 'Try again'));
    await settle();

    // The same element, which was there before it had something to say.
    expect(within(retrying).getByRole('status')).toBe(status);
    expect(status.textContent).toBe('Trying again…');

    answer.resolve(null);
    await settle();
  });
});
