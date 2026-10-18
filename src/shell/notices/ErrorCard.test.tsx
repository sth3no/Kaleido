import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import HomeScreen from '../../home/HomeScreen';
import { initI18n, setLanguage } from '../../i18n';
import { shouldForward } from '../../input/forward';
import { MAX_NOTICES, NOTICE_MS, pushAppNotice, useNoticeStore } from '../../state/noticeStore';
import { usePlayerStore } from '../../state/playerStore';
import { useUiStore } from '../../state/uiStore';
import ErrorCards, { LOG_FOLLOW_MS } from './ErrorCards';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
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

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: FAKE });
  events.handlers.clear();
  vi.mocked(invoke).mockClear();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  useNoticeStore.setState(useNoticeStore.getInitialState(), true);
});

afterEach(() => {
  vi.useRealTimers();
  setLanguage('en');
});

const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

/** The cards, newest first. */
const cards = () => screen.queryAllByRole('listitem');

/**
 * `player:end-file` for a file that failed, `file` being the playlist entry Rust names and
 * `continues` whether Rust says mpv goes on by itself; a new object each time, as every event is one.
 */
const fails = (
  error: string | null = 'loading failed',
  file: string | null = null,
  continues = false,
) => {
  act(() => {
    usePlayerStore.getState().endFile({ reason: 'error', error, file, continues });
  });
};

/** The playlist as mpv reports it, `current` being the index of the entry that plays. */
const playlist = (current: number, ...names: string[]) => {
  act(() => {
    usePlayerStore.getState().applyChanges({
      playlist: names.map((filename, index) => (index === current ? { filename, current: true } : { filename })),
    });
  });
};

const log = (level: 'warn' | 'error', prefix: string, text: string) => {
  act(() => {
    usePlayerStore.getState().addLog({ level, prefix, text });
  });
};

/** Rust says Ctrl+V found no link (`system:paste-empty`): every listener hears it. */
const pasteEmpty = () => {
  act(() => {
    for (const handler of events.handlers.get('system:paste-empty') ?? []) handler({ payload: {} });
  });
};

/** The player is shown (a file is loaded). */
const playing = () => {
  act(() => {
    usePlayerStore.setState({ loaded: true, props: { 'idle-active': false } });
  });
};

const sentCommands = (name: string) => vi.mocked(invoke).mock.calls.filter(([command]) => command === name);

describe('a file that cannot be played', () => {
  test('error card shows details from log tail', () => {
    render(<ErrorCards />);
    // What mpv logged about the file, then the end of it.
    log('warn', 'ffmpeg', 'Invalid NAL unit size');
    log('error', 'stream', 'Cannot open file');
    log('error', 'cplayer', 'Failed to open a.mkv.');
    fails('loading failed');

    const [card] = cards();
    expect(cards()).toHaveLength(1);
    // The message is in words, and the log is behind "Details".
    expect(within(card).getByRole('alert').textContent).toContain('could not be opened');
    expect(screen.queryByText('[cplayer] Failed to open a.mkv.')).toBeNull();

    const details = within(card).getByRole('button', { name: 'Details' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(details);

    expect(details.getAttribute('aria-expanded')).toBe('true');
    for (const line of [
      '[mpv] loading failed',
      '[ffmpeg] Invalid NAL unit size',
      '[stream] Cannot open file',
      '[cplayer] Failed to open a.mkv.',
    ]) {
      expect(within(card).getByText(line), line).toBeTruthy();
    }
    // The button names what it opens.
    expect(document.getElementById(details.getAttribute('aria-controls') ?? '')).not.toBeNull();

    fireEvent.click(details);
    expect(details.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('[cplayer] Failed to open a.mkv.')).toBeNull();
  });

  test('the details show the last lines only, oldest first, and trim what mpv ends them with', () => {
    render(<ErrorCards />);
    for (let n = 1; n <= 12; n += 1) log('error', 'cplayer', `line ${n}\n`);
    fails();

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));

    const lines = screen.getAllByText(/^\[cplayer\] line /).map((element) => element.textContent);
    expect(lines).toEqual(['5', '6', '7', '8', '9', '10', '11', '12'].map((n) => `[cplayer] line ${n}`));
  });

  test('the lines that mpv logs just after end-file are in the details too, those long after are not', () => {
    render(<ErrorCards />);
    fails();
    log('error', 'cplayer', 'Failed to recognize file format.');
    advance(LOG_FOLLOW_MS + 1);
    log('warn', 'ffmpeg', 'a warning of the next file');

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));

    expect(screen.getByText('[cplayer] Failed to recognize file format.')).toBeTruthy();
    expect(screen.queryByText('[ffmpeg] a warning of the next file')).toBeNull();
  });

  test('a card with nothing logged still has mpv\'s word for the error', () => {
    render(<ErrorCards />);
    fails('not supported');

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));

    expect(screen.getByText('[mpv] not supported')).toBeTruthy();
  });

  test('a card without an error string says that nothing was written', () => {
    render(<ErrorCards />);
    fails(null);

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));

    expect(screen.getByText('Nothing was written to the log.')).toBeTruthy();
  });

  const MESSAGES: [error: string | null, message: string | RegExp][] = [
    ['loading failed', /could not be opened/],
    ['unrecognized file format', /not recognized or not supported/],
    ['not supported', /not recognized or not supported/],
    ['video output initialization failed', 'The file could not be played.'],
    [null, 'The file could not be played.'],
  ];

  test.each(MESSAGES)('mpv says %s: the card says %s', (error, message) => {
    render(<ErrorCards />);
    fails(error);

    expect(within(cards()[0]).getByText(message)).toBeTruthy();
  });

  test('the card names the file Rust says failed, or says it does not know it', () => {
    render(<ErrorCards />);
    fails('loading failed', 'C:\\Videa (2026)\\poškozený soubor.mkv');
    expect(screen.getByText('Cannot play poškozený soubor.mkv')).toBeTruthy();

    // Rust found no such entry in the playlist.
    fails('loading failed', null);
    expect(screen.getByText('Cannot play this file')).toBeTruthy();
  });

  test('the name is the failed file\'s, not that of the entry that is current', () => {
    render(<ErrorCards />);
    // mpv has gone on to the third entry; the one that failed was the first.
    playlist(2, 'C:\\Videa\\první.mkv', 'C:\\Videa\\druhý.mkv', 'C:\\Videa\\třetí.mkv');

    fails('loading failed', 'C:\\Videa\\první.mkv');

    expect(screen.getByText('Cannot play první.mkv')).toBeTruthy();
    expect(screen.queryByText('Cannot play třetí.mkv')).toBeNull();
  });

  test('a long path is named without its prefix, a link by its host', () => {
    render(<ErrorCards />);
    fails('loading failed', '\\\\?\\C:\\Videa\\a.mkv');
    fails('loading failed', 'https://user:secret@example.com/watch?v=abc');

    expect(screen.getByText('Cannot play a.mkv')).toBeTruthy();
    expect(screen.getByText('Cannot play example.com')).toBeTruthy();
    expect(document.body.textContent).not.toContain('secret');
  });

  test('only an error makes a card, and one that was there before the stack is no card', () => {
    act(() => {
      usePlayerStore.setState({ lastEnd: { reason: 'error', error: 'loading failed', file: null, continues: false } });
    });
    render(<ErrorCards />);
    expect(cards()).toHaveLength(0);

    for (const reason of ['eof', 'stop', 'quit', 'redirect'] as const) {
      act(() => {
        usePlayerStore.getState().endFile({ reason, error: null, file: null, continues: false });
      });
    }
    expect(cards()).toHaveLength(0);

    fails();
    expect(cards()).toHaveLength(1);
  });

  test('under StrictMode, which subscribes twice, one failure is one card', () => {
    render(
      <StrictMode>
        <ErrorCards />
      </StrictMode>,
    );

    fails();

    expect(cards()).toHaveLength(1);
  });

  test('the card is in the language of the app, also when it changes', () => {
    render(<ErrorCards />);
    fails();

    act(() => {
      setLanguage('cs');
    });

    expect(within(cards()[0]).getByRole('alert').textContent).toContain('nepodařilo otevřít');
    expect(screen.getByRole('button', { name: 'Podrobnosti' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zavřít' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Otevřít soubor' })).toBeTruthy();
  });
});

describe('what the card says is going on (Rulings R41, R43)', () => {
  const SENTENCE = 'Playback continues with the next file.';

  test('error card says playback continues only when mpv goes on, and offers Open file only when playback ended', () => {
    render(<ErrorCards />);

    // Rust says that mpv goes on: an entry follows the one that failed.
    fails('loading failed', 'a.mkv', true);
    const continuing = cards()[0];
    expect(within(continuing).getByText(SENTENCE)).toBeTruthy();
    expect(within(continuing).queryByRole('button', { name: 'Open file' })).toBeNull();

    // Rust says that it does not: the last one failed, and nothing is left to play.
    fails('loading failed', 'c.mkv', false);
    const ended = cards()[0];
    expect(within(ended).queryByText(SENTENCE)).toBeNull();
    expect(within(ended).getByRole('button', { name: 'Open file' })).toBeTruthy();

    // The first card keeps what it was told.
    expect(within(cards()[1]).getByText(SENTENCE)).toBeTruthy();
    expect(within(cards()[1]).queryByRole('button', { name: 'Open file' })).toBeNull();
  });

  test('there is no Next: mpv goes on by itself, and Next would skip a file nobody saw', () => {
    render(<ErrorCards />);
    fails('loading failed', 'a.mkv', true);
    fails('loading failed', 'c.mkv', false);

    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    expect(sentCommands('player_command')).toEqual([]);
  });

  test('it is Rust\'s word: the UI\'s own copy of the playlist is not asked, however old it is', () => {
    render(<ErrorCards />);
    // A list was just opened and its first file fails at once: the UI still has the list from
    // before (none), because the change of the playlist is behind the events that are queued.
    act(() => {
      usePlayerStore.getState().applyChanges({ playlist: [] });
    });
    fails('loading failed', 'a.mkv', true);
    expect(within(cards()[0]).getByText(SENTENCE)).toBeTruthy();
    expect(within(cards()[0]).queryByRole('button', { name: 'Open file' })).toBeNull();

    // And a list that shows entries after the failed one does not make it go on.
    playlist(0, 'a.mkv', 'b.mkv', 'c.mkv');
    fails('loading failed', 'a.mkv', false);
    expect(within(cards()[0]).queryByText(SENTENCE)).toBeNull();
    expect(within(cards()[0]).getByRole('button', { name: 'Open file' })).toBeTruthy();
  });

  test('a file Rust could not name still has the word on whether mpv goes on', () => {
    render(<ErrorCards />);
    // A playlist that loops: mpv starts over, whichever file it was.
    fails('loading failed', null, true);
    expect(within(cards()[0]).getByText('Cannot play this file')).toBeTruthy();
    expect(within(cards()[0]).getByText(SENTENCE)).toBeTruthy();

    // Nothing is known to play next.
    fails('loading failed', null, false);
    expect(within(cards()[0]).getByRole('button', { name: 'Open file' })).toBeTruthy();
    expect(within(cards()[0]).queryByText(SENTENCE)).toBeNull();
  });

  test('the sentence is part of what is read out with the failure', () => {
    render(<ErrorCards />);
    fails('loading failed', 'a.mkv', true);

    expect(within(cards()[0]).getByRole('alert').textContent).toContain(SENTENCE);
  });

  test('Open file asks for the open dialog and closes the card', () => {
    render(<ErrorCards />);
    fails('loading failed', 'a.mkv');

    fireEvent.click(within(cards()[0]).getByRole('button', { name: 'Open file' }));

    expect(sentCommands('system_open_dialog')).toEqual([['system_open_dialog', { purpose: 'media' }]]);
    expect(cards()).toHaveLength(0);
  });

  test('a dialog that cannot open is logged, and the card is gone all the same', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(invoke).mockRejectedValueOnce('no dialog');
    render(<ErrorCards />);
    fails('loading failed', 'a.mkv');

    fireEvent.click(within(cards()[0]).getByRole('button', { name: 'Open file' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(cards()).toHaveLength(0);
    warn.mockRestore();
  });

  test('Close and Details are always there', () => {
    render(<ErrorCards />);
    fails('loading failed', 'a.mkv', true);
    fails('loading failed', null, false);

    for (const card of cards()) {
      expect(within(card).getByRole('button', { name: 'Close' })).toBeTruthy();
      expect(within(card).getByRole('button', { name: 'Details' })).toBeTruthy();
    }
  });

  test('Close closes the card, and only that one', () => {
    render(<ErrorCards />);
    fails('loading failed', 'a.mkv');
    fails('loading failed', 'b.mkv');
    expect(cards()).toHaveLength(2);

    fireEvent.click(within(cards()[0]).getByRole('button', { name: 'Close' }));

    expect(cards()).toHaveLength(1);
    expect(screen.getByText('Cannot play a.mkv')).toBeTruthy();
    expect(screen.queryByText('Cannot play b.mkv')).toBeNull();
  });
});

describe('the stack', () => {
  test('at most three error cards stack, the newest on top', () => {
    expect(MAX_NOTICES).toBe(3);
    render(<ErrorCards />);
    for (const name of ['1.mkv', '2.mkv', '3.mkv', '4.mkv']) fails('loading failed', name);

    expect(cards()).toHaveLength(3);
    const titles = screen.getAllByText(/^Cannot play /).map((element) => element.textContent);
    expect(titles).toEqual(['Cannot play 4.mkv', 'Cannot play 3.mkv', 'Cannot play 2.mkv']);
  });

  test('is a list of notifications, glass in one piece', () => {
    render(<ErrorCards />);
    fails();

    const list = screen.getByRole('list', { name: 'Notifications' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  });

  test('is not in the page while there is nothing to show', () => {
    render(<ErrorCards />);
    expect(screen.queryByRole('list')).toBeNull();

    fails();
    expect(screen.getByRole('list')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('time', () => {
  test('a card goes after 8 seconds', () => {
    expect(NOTICE_MS).toBe(8000);
    render(<ErrorCards />);
    fails();

    advance(NOTICE_MS - 1);
    expect(cards()).toHaveLength(1);
    advance(1);
    expect(cards()).toHaveLength(0);
  });

  test('each card has its own 8 seconds', () => {
    render(<ErrorCards />);
    fails();
    advance(5000);
    fails();
    expect(cards()).toHaveLength(2);

    advance(3000);
    expect(cards()).toHaveLength(1);
    advance(5000);
    expect(cards()).toHaveLength(0);
  });

  test('a card under the pointer stays, and the 8 seconds start again when the pointer leaves', () => {
    render(<ErrorCards />);
    fails();
    const card = cards()[0];

    fireEvent.pointerEnter(card);
    advance(NOTICE_MS * 3);
    expect(cards()).toHaveLength(1);

    fireEvent.pointerLeave(card);
    advance(NOTICE_MS - 1);
    expect(cards()).toHaveLength(1);
    advance(1);
    expect(cards()).toHaveLength(0);
  });

  test('a card with its details open stays, and the 8 seconds start again when they are closed', () => {
    render(<ErrorCards />);
    fails();

    const details = screen.getByRole('button', { name: 'Details' });
    fireEvent.click(details);
    advance(NOTICE_MS * 3);
    expect(cards()).toHaveLength(1);

    fireEvent.click(details);
    advance(NOTICE_MS);
    expect(cards()).toHaveLength(0);
  });

  test('a card that has the focus stays', () => {
    render(<ErrorCards />);
    fails();
    const close = screen.getByRole('button', { name: 'Close' });

    act(() => {
      close.focus();
    });
    advance(NOTICE_MS * 3);
    expect(cards()).toHaveLength(1);

    act(() => {
      close.blur();
    });
    advance(NOTICE_MS);
    expect(cards()).toHaveLength(0);
  });
});

describe('the keyboard', () => {
  test('a new card does not take the focus, and can be reached with Tab', () => {
    render(
      <>
        <button type="button">Outside</button>
        <ErrorCards />
      </>,
    );
    const outside = screen.getByRole('button', { name: 'Outside' });
    outside.focus();

    fails();

    expect(document.activeElement).toBe(outside);
    // Every control of the card is a button or a link in the page's order: nothing has tabindex.
    for (const control of within(cards()[0]).getAllByRole('button')) {
      expect(control.hasAttribute('tabindex')).toBe(false);
      expect((control as HTMLButtonElement).disabled).toBe(false);
    }
  });

  test('Esc on a focused card closes it, and the key does not go on to mpv', () => {
    render(
      <>
        <button type="button">Outside</button>
        <ErrorCards />
      </>,
    );
    const outside = screen.getByRole('button', { name: 'Outside' });
    fails();
    outside.focus();
    const close = within(cards()[0]).getByRole('button', { name: 'Close' });
    act(() => {
      close.focus();
    });
    expect(document.activeElement).toBe(close);

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      close.dispatchEvent(escape);
    });

    // Handled by the card: the window's forwarder (input/forward.ts) leaves it alone.
    expect(escape.defaultPrevented).toBe(true);
    expect(shouldForward(escape)).toBe(false);
    expect(cards()).toHaveLength(0);
    // Back where the focus came from.
    expect(document.activeElement).toBe(outside);
  });

  test('Esc on any control of the card closes it, the Details button too', () => {
    render(<ErrorCards />);
    fails();

    const handled = !fireEvent.keyDown(screen.getByRole('button', { name: 'Details' }), {
      key: 'Escape',
    });

    expect(handled).toBe(true);
    expect(cards()).toHaveLength(0);
  });

  test('other keys on a card are left alone: the arrows still reach mpv', () => {
    render(<ErrorCards />);
    fails();

    const notHandled = fireEvent.keyDown(screen.getByRole('button', { name: 'Details' }), {
      key: 'ArrowRight',
    });

    expect(notHandled).toBe(true);
    expect(cards()).toHaveLength(1);
  });

  test('a card that is closed with the pointer moves no focus', () => {
    render(
      <>
        <button type="button">Outside</button>
        <ErrorCards />
      </>,
    );
    fails();
    const outside = screen.getByRole('button', { name: 'Outside' });
    outside.focus();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(cards()).toHaveLength(0);
    expect(document.activeElement).toBe(outside);
  });
});

describe('what the app itself says', () => {
  test('a notice of the app is a card with a message and Close, and no Details', () => {
    render(<ErrorCards />);

    act(() => {
      pushAppNotice('errors.dropLink');
    });

    const card = cards()[0];
    expect(within(card).getByRole('alert').textContent).toContain('dropped link could not be opened');
    expect(within(card).getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Details' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Open file' })).toBeNull();
    expect(within(card).queryByText('Playback continues with the next file.')).toBeNull();
  });

  test('a failure is read out at once, by its card', () => {
    render(<ErrorCards />);
    act(() => {
      pushAppNotice('errors.dropLink');
    });
    expect(within(cards()[0]).getByRole('alert')).toBeTruthy();

    fails();
    expect(within(cards()[0]).getByRole('alert')).toBeTruthy();
  });

  test('a hint is read out politely by a region that is in the page before it has one', () => {
    render(<ErrorCards />);
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');

    act(() => {
      pushAppNotice('errors.pasteEmpty', 'status');
    });

    // The same element, now with the text; the card shows it too but is no live region itself.
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toContain('no link on the clipboard');
    expect(within(cards()[0]).getByText(/no link on the clipboard/)).toBeTruthy();
    expect(within(cards()[0]).queryByRole('status')).toBeNull();
    expect(within(cards()[0]).queryByRole('alert')).toBeNull();

    // A failure does not go through it.
    fails();
    expect(region.textContent).toContain('no link on the clipboard');
    expect(within(cards()[0]).getByRole('alert')).toBeTruthy();

    // The hint goes with its card, and the region is empty again.
    advance(NOTICE_MS);
    expect(region.textContent).toBe('');
  });

  test('the same hint again is announced again: its text is a new node of the region', () => {
    render(<ErrorCards />);
    const region = screen.getByRole('status');
    act(() => {
      pushAppNotice('errors.pasteEmpty', 'status');
    });
    const first = region.firstElementChild;
    expect(first).not.toBeNull();

    act(() => {
      pushAppNotice('errors.pasteEmpty', 'status');
    });

    expect(region.firstElementChild).not.toBeNull();
    expect(region.firstElementChild).not.toBe(first);
    expect(region.textContent).toContain('no link on the clipboard');
  });

  test('the same notice twice is one card', () => {
    render(<ErrorCards />);

    act(() => {
      pushAppNotice('errors.pasteEmpty', 'status');
      pushAppNotice('errors.pasteEmpty', 'status');
    });

    expect(cards()).toHaveLength(1);
  });

  test('app notices and failed files share the three places and the 8 seconds', () => {
    render(<ErrorCards />);
    act(() => {
      pushAppNotice('errors.dropLink');
    });
    fails();
    fails();
    fails();

    expect(cards()).toHaveLength(3);
    expect(screen.queryByText(/dropped link/)).toBeNull();

    advance(NOTICE_MS);
    expect(cards()).toHaveLength(0);
  });
});

describe('something inside Kaleido failed (system:error)', () => {
  test('a card says so, on the start screen as on the player, once however often it comes', () => {
    render(<ErrorCards />);
    const failed = () => {
      act(() => {
        for (const handler of events.handlers.get('system:error') ?? []) handler({ payload: {} });
      });
    };

    failed();
    expect(cards()).toHaveLength(1);
    expect(within(cards()[0]).getByRole('alert').textContent).toContain(
      'Something went wrong inside Kaleido',
    );

    playing();
    failed();
    expect(cards()).toHaveLength(1);
  });
});

describe('Ctrl+V without a link (system:paste-empty)', () => {
  test('outside the start screen it says so on a card', () => {
    render(<ErrorCards />);
    playing();

    pasteEmpty();

    expect(cards()).toHaveLength(1);
    expect(within(cards()[0]).getByText(/no link on the clipboard/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('no link on the clipboard');
  });

  test('on the settings page, which has no paste field, too', () => {
    render(<ErrorCards />);
    act(() => {
      useUiStore.getState().setPage('settings');
    });

    pasteEmpty();

    expect(cards()).toHaveLength(1);
  });

  test('on the start screen the card stays away: the paste field answers', () => {
    render(<ErrorCards />);
    // Nothing is open and mpv is idle.
    act(() => {
      usePlayerStore.setState({ loaded: false, props: { 'idle-active': true } });
    });

    pasteEmpty();

    expect(cards()).toHaveLength(0);
    // Nor does the live region say it: the paste field is what the user is given.
    expect(screen.getByRole('status').textContent).toBe('');
  });

  test('the start screen and the cards never both react', () => {
    // As the app has it: the start screen is mounted exactly while the view is the start screen.
    act(() => {
      usePlayerStore.setState({ loaded: false, props: { 'idle-active': true } });
    });
    render(
      <>
        <HomeScreen />
        <ErrorCards />
      </>,
    );
    expect(screen.queryByRole('textbox', { name: 'Link to a video' })).toBeNull();

    pasteEmpty();

    expect(screen.getByRole('textbox', { name: 'Link to a video' })).toBeTruthy();
    expect(cards()).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  test('it is the view at the moment of the event that decides', () => {
    render(<ErrorCards />);
    pasteEmpty();
    expect(cards()).toHaveLength(0);

    playing();
    pasteEmpty();
    expect(cards()).toHaveLength(1);

    // Back to the start screen: a file ended and mpv is idle.
    act(() => {
      usePlayerStore.setState({ loaded: false, props: { 'idle-active': true } });
      useNoticeStore.setState(useNoticeStore.getInitialState(), true);
    });
    pasteEmpty();
    expect(cards()).toHaveLength(0);
  });
});
