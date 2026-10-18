import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../../i18n';
import { attachVideoInput } from '../../input/forward';
import type { Binding, BindingSource } from '../../ipc/types';
import Shortcuts from './Shortcuts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const bind = (
  key: string,
  command: string,
  source: BindingSource = { type: 'kaleido' },
  comment: string | null = null,
): Binding => ({ key, command, source, comment });

const SEEK = 'no-osd seek 5; script-message kaleido osd seek';

/** What mpv lists when the app starts. */
const START: Binding[] = [
  bind('RIGHT', SEEK),
  bind('m', 'no-osd cycle mute; script-message kaleido osd volume'),
  bind('Ctrl+f', 'cycle fullscreen', { type: 'user' }, 'My fullscreen'),
  bind('q', 'ignore', { type: 'user' }),
  bind('f', 'cycle fullscreen', { type: 'mpv' }),
  bind('i', 'script-binding stats/display-stats', { type: 'plugin', name: 'stats' }),
  bind('Ctrl+h', 'script-binding thumbfast/toggle', { type: 'plugin', name: 'thumbfast' }),
];

type Answers = Record<string, (args: unknown) => unknown>;

/** The bindings mpv has now; `settings_rebind` and `settings_reset_binding` change them as Rust does. */
let listed: Binding[];

/** What Rust does for a rebind: the old key is silenced and the new one has the command. */
function moveBinding(key: string, newKey: string) {
  const from = listed.find((entry) => entry.key === key);
  if (!from) return;
  listed = [
    ...listed.filter((entry) => entry.key !== key && entry.key !== newKey),
    bind(newKey, from.command, { type: 'user' }, from.comment),
    bind(key, 'ignore', { type: 'user' }),
  ];
}

function rust(answers: Answers = {}) {
  const all: Answers = {
    settings_bindings: () => listed,
    settings_rebind: (args) => {
      const { key, newKey } = args as { key: string; newKey: string };
      moveBinding(key, newKey);
      return null;
    },
    settings_reset_binding: (args) => {
      const { key } = args as { key: string };
      // A line of Kaleido's default input.conf is back; what the user made up is silenced until the next start.
      listed = listed.map((entry) =>
        entry.key !== key
          ? entry
          : START.find((original) => original.key === key) ?? bind(key, 'ignore', { type: 'user' }),
      );
      return null;
    },
    ...answers,
  };
  vi.mocked(invoke).mockImplementation(((command: string, args?: unknown) =>
    Promise.resolve(all[command]?.(args) ?? null)) as unknown as typeof invoke);
}

const sent = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);
/** The arguments of the calls to `command`. */
const calls = (command: string) => sent(command).map(([, args]) => args);
/** What was passed on to mpv. */
const forwarded = () => sent('player_input');

/** Lets the answers that are on their way arrive, and what they set in motion run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The page, once the bindings are listed. */
async function open() {
  const view = render(<Shortcuts />);
  await screen.findByRole('heading', { level: 3, name: 'Kaleido' });
  return view;
}

const change = (key: string) => screen.getByRole('button', { name: `Change shortcut ${key}` });
const reset = (key: string) => screen.getByRole('button', { name: `Reset shortcut ${key}` });
/** The row of a binding. */
const row = (key: string) => {
  const found = Array.from(document.querySelectorAll('[data-binding]')).find(
    (element) => element.getAttribute('data-binding') === key,
  );
  if (!(found instanceof HTMLElement)) throw new Error(`no row for ${key}`);
  return found;
};
const headings = () =>
  screen.queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
const keysShown = () =>
  Array.from(document.querySelectorAll('[data-binding]')).map((element) => element.getAttribute('data-binding'));
const searchField = () => screen.getByRole('searchbox', { name: 'Search shortcuts' }) as HTMLInputElement;
/** The page's own status line (the hint of a waiting row is a status too). */
const pageStatus = () => document.querySelector('div[role="search"] + p[role="status"]');

/** A key goes down on the page, where nothing has the focus. */
const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
  fireEvent.keyDown(target, { key, ...init });

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  listed = [...START];
  rust();
  // A read or a change that Rust refuses is logged, and some tests make it.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  setLanguage('en');
});

describe('the list', () => {
  test('is grouped by where the bindings come from: Kaleido, Custom, mpv, then each plugin', async () => {
    await open();

    expect(headings()).toEqual(['Kaleido', 'Custom', 'mpv', 'stats', 'thumbfast']);
    expect(keysShown()).toEqual(['RIGHT', 'm', 'Ctrl+f', 'q', 'f', 'i', 'Ctrl+h']);
    // Each row: the key, and what it does.
    expect(within(row('RIGHT')).getByText('RIGHT').tagName).toBe('KBD');
    expect(within(row('RIGHT')).getByText(SEEK)).toBeTruthy();
    // A description comes first, and the command under it.
    expect(within(row('Ctrl+f')).getByText('My fullscreen')).toBeTruthy();
    expect(within(row('Ctrl+f')).getByText('cycle fullscreen')).toBeTruthy();
    // The groups are lists under their headings.
    const group = screen.getByRole('region', { name: 'stats' });
    expect(within(group).getAllByRole('listitem')).toHaveLength(1);
    expect(sent('settings_bindings')).toHaveLength(1);
  });

  test('a silenced key is listed Disabled, with no Change but a Reset, as any key that does nothing', async () => {
    // A key made up and reset is `ignore` and the user's, until the next start; so is one that was moved.
    await open();

    expect(within(row('q')).getByText('Disabled')).toBeTruthy();
    expect(within(row('q')).queryByText('ignore')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change shortcut q' })).toBeNull();
    expect(reset('q')).toBeTruthy();
    // The rest have both.
    expect(change('m')).toBeTruthy();
    expect(reset('m')).toBeTruthy();
  });

  test('a plugin\'s binding is shown without the prefix mpv puts in front of it', async () => {
    listed = [
      ...START,
      bind('Ctrl+j', 'nonscalable script-binding testbind/test-x', { type: 'plugin', name: 'testbind' }),
    ];
    rust();
    await open();

    expect(within(row('Ctrl+j')).getByText('script-binding testbind/test-x')).toBeTruthy();
    expect(within(row('Ctrl+j')).queryByText(/nonscalable/)).toBeNull();
    // The question about a key it has says it the same way.
    fireEvent.click(change('m'));
    press('j', { code: 'KeyJ', ctrlKey: true });
    expect(within(row('m')).getByRole('alert').textContent).toBe(
      'Ctrl+j already does this: script-binding testbind/test-x. Replace it?',
    );
  });

  test('every binding has a Reset, a plugin\'s too', async () => {
    await open();
    for (const key of ['RIGHT', 'Ctrl+f', 'f', 'i', 'Ctrl+h']) expect(reset(key)).toBeTruthy();
  });

  test('searches the keys, the commands, the descriptions and the groups', async () => {
    await open();
    expect(pageStatus()?.textContent).toBe('');

    fireEvent.change(searchField(), { target: { value: 'fullscreen' } });
    expect(keysShown()).toEqual(['Ctrl+f', 'f']);
    expect(headings()).toEqual(['Custom', 'mpv']);
    expect(pageStatus()?.textContent).toBe('Found: 2');

    fireEvent.change(searchField(), { target: { value: 'stats' } });
    expect(keysShown()).toEqual(['i']);

    fireEvent.change(searchField(), { target: { value: 'ctrl+h' } });
    expect(keysShown()).toEqual(['Ctrl+h']);

    fireEvent.change(searchField(), { target: { value: 'zzz' } });
    expect(keysShown()).toEqual([]);
    expect(headings()).toEqual([]);
    expect(pageStatus()?.textContent).toBe('No shortcuts match “zzz”.');

    fireEvent.change(searchField(), { target: { value: '' } });
    expect(keysShown()).toHaveLength(START.length);
  });

  test('Esc clears the search and is handled; with nothing typed it is not the search\'s', async () => {
    await open();
    fireEvent.change(searchField(), { target: { value: 'seek' } });

    expect(fireEvent.keyDown(searchField(), { key: 'Escape' })).toBe(false);
    expect(searchField().value).toBe('');
    expect(fireEvent.keyDown(searchField(), { key: 'Escape' })).toBe(true);
  });

  test('typing in the search is not forwarded to mpv', async () => {
    await open();
    const detach = attachVideoInput(document.createElement('div'));
    try {
      press('a', { code: 'KeyA' }, searchField());
      expect(forwarded()).toEqual([]);
    } finally {
      detach();
    }
  });
});

describe('what cannot be shown', () => {
  test('a player that is not up answers with no bindings, which is said, and can be read again', async () => {
    listed = [];
    rust();
    render(<Shortcuts />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The player is not ready yet, so its shortcuts cannot be shown.');
    expect(keysShown()).toEqual([]);

    listed = [...START];
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { level: 3, name: 'Kaleido' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a read that fails is said, and can be read again', async () => {
    rust({ settings_bindings: () => Promise.reject('no player') });
    render(<Shortcuts />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The shortcuts could not be read.');
    expect(console.warn).toHaveBeenCalled();

    rust();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { level: 3, name: 'Kaleido' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('an answer that is no list is a failed read, not an empty list', async () => {
    rust({ settings_bindings: () => ({ not: 'a list' }) });
    render(<Shortcuts />);
    expect((await screen.findByRole('alert')).textContent).toContain('The shortcuts could not be read.');
  });

  test('it says it is loading until Rust answers', async () => {
    let answer: (value: unknown) => void = () => undefined;
    rust({
      settings_bindings: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    render(<Shortcuts />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => {
      answer(START);
      await Promise.resolve();
    });
    await screen.findByRole('heading', { level: 3, name: 'Kaleido' });
    expect(screen.queryByText('Loading…')).toBeNull();
  });
});

describe('changing a shortcut', () => {
  test('rebind captures the next key and warns on a conflict', async () => {
    await open();

    // Change waits for a key, and says so.
    fireEvent.click(change('m'));
    expect(change('m').getAttribute('aria-pressed')).toBe('true');
    expect(within(row('m')).getByRole('status').textContent).toBe('Press the new key for m. Esc cancels.');
    expect(calls('settings_rebind')).toEqual([]);

    // The next key press is the answer: Rust is asked to move the binding there, with keys only.
    expect(press('x', { code: 'KeyX' })).toBe(false);
    expect(calls('settings_rebind')).toEqual([{ key: 'm', newKey: 'x' }]);
    // The list is read again: the new key is the user's, and the old one is silenced.
    await waitFor(() => {
      expect(pageStatus()?.textContent).toBe('Shortcut moved from m to x.');
    });
    expect(within(row('x')).getByText('no-osd cycle mute; script-message kaleido osd volume')).toBeTruthy();
    expect(within(row('m')).getByText('Disabled')).toBeTruthy();
    expect(within(row('x')).queryByRole('status')).toBeNull();
    expect(sent('settings_bindings')).toHaveLength(2);

    // A key that is bound already is shown with what it does, and nothing is replaced yet.
    fireEvent.click(change('x'));
    press('f');
    expect(calls('settings_rebind')).toHaveLength(1);
    const question = within(row('x')).getByRole('alert');
    expect(question.textContent).toBe('f already does this: cycle fullscreen. Replace it?');
    expect(within(row('x')).getByRole('button', { name: 'Replace' })).toBeTruthy();
    // The row is not waiting for a key any more, and no key is Esc's.
    expect(change('x').getAttribute('aria-pressed')).toBe('false');

    // Replace asks Rust, which overwrites the key.
    fireEvent.click(within(row('x')).getByRole('button', { name: 'Replace' }));
    expect(calls('settings_rebind')).toEqual([
      { key: 'm', newKey: 'x' },
      { key: 'x', newKey: 'f' },
    ]);
    await waitFor(() => {
      expect(within(row('f')).getByText('no-osd cycle mute; script-message kaleido osd volume')).toBeTruthy();
    });
    expect(within(row('f')).getByText('no-osd cycle mute; script-message kaleido osd volume')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a conflict can be dropped, with Cancel or with Esc, and nothing is replaced', async () => {
    await open();

    fireEvent.click(change('m'));
    press('f');
    fireEvent.click(within(row('m')).getByRole('button', { name: 'Cancel' }));
    expect(within(row('m')).queryByRole('alert')).toBeNull();

    fireEvent.click(change('m'));
    press('f');
    expect(within(row('m')).getByRole('alert')).toBeTruthy();
    // Esc in the row is handled: mpv would leave fullscreen.
    expect(fireEvent.keyDown(within(row('m')).getByRole('button', { name: 'Replace' }), { key: 'Escape' })).toBe(false);
    expect(within(row('m')).queryByRole('alert')).toBeNull();

    expect(calls('settings_rebind')).toEqual([]);
  });

  test('a key that is bound to nothing, or only silenced, is free', async () => {
    await open();
    // q is silenced: its key is free to take.
    fireEvent.click(change('m'));
    press('q');
    expect(within(row('m')).queryByRole('alert')).toBeNull();
    expect(calls('settings_rebind')).toEqual([{ key: 'm', newKey: 'q' }]);
    await settle();
  });

  test('a conflict is found whatever the order and the case the modifiers are spelled in', async () => {
    // mpv may name the key with the modifiers the other way round; the press is Ctrl+Shift+F5.
    listed = [...START, bind('shift+ctrl+F5', 'cycle pause', { type: 'mpv' })];
    rust();
    await open();

    fireEvent.click(change('m'));
    press('F5', { ctrlKey: true, shiftKey: true });

    expect(calls('settings_rebind')).toEqual([]);
    expect(within(row('m')).getByRole('alert').textContent).toBe(
      'Ctrl+Shift+F5 already does this: cycle pause. Replace it?',
    );
  });

  test('pressing the key the shortcut has changes nothing', async () => {
    await open();
    fireEvent.click(change('m'));
    press('m', { code: 'KeyM' });
    expect(calls('settings_rebind')).toEqual([]);
    // The wait is over.
    expect(change('m').getAttribute('aria-pressed')).toBe('false');
    expect(within(row('m')).queryByRole('status')).toBeNull();
  });

  test('Esc cancels the wait, and the key does not reach mpv', async () => {
    await open();
    const detach = attachVideoInput(document.createElement('div'));
    try {
      fireEvent.click(change('m'));
      expect(within(row('m')).getByRole('status')).toBeTruthy();

      // Handled: neither the page nor mpv (where it leaves fullscreen) gets it.
      expect(press('Escape', { code: 'Escape' })).toBe(false);
      expect(within(row('m')).queryByRole('status')).toBeNull();
      expect(change('m').getAttribute('aria-pressed')).toBe('false');
      expect(calls('settings_rebind')).toEqual([]);
      expect(forwarded()).toEqual([]);

      // The wait is over: the keys are mpv's again.
      press('x', { code: 'KeyX' });
      expect(forwarded()).toHaveLength(1);
      expect(calls('settings_rebind')).toEqual([]);
    } finally {
      detach();
    }
  });

  test('the key that answers does not also reach mpv, and nothing is sent for its release', async () => {
    await open();
    const detach = attachVideoInput(document.createElement('div'));
    try {
      fireEvent.click(change('m'));
      press('x', { code: 'KeyX' });
      fireEvent.keyUp(document.body, { key: 'x', code: 'KeyX' });
      expect(forwarded()).toEqual([]);
      expect(calls('settings_rebind')).toEqual([{ key: 'm', newKey: 'x' }]);
      await settle();
    } finally {
      detach();
    }
  });

  test('a modifier on its own does not end the wait', async () => {
    await open();
    const detach = attachVideoInput(document.createElement('div'));
    try {
      fireEvent.click(change('m'));

      for (const [key, init] of [
        ['Control', { ctrlKey: true }],
        ['Shift', { shiftKey: true }],
        ['Alt', { altKey: true }],
        ['AltGraph', {}],
        ['Meta', { metaKey: true }],
      ] as const) {
        press(key, init);
        expect(within(row('m')).getByRole('status'), key).toBeTruthy();
      }
      expect(calls('settings_rebind')).toEqual([]);
      expect(forwarded()).toEqual([]);

      // The key with the modifier held is the answer.
      press('k', { code: 'KeyK', ctrlKey: true });
      expect(calls('settings_rebind')).toEqual([{ key: 'm', newKey: 'Ctrl+k' }]);
      await settle();
    } finally {
      detach();
    }
  });

  test('a held key is one press', async () => {
    await open();
    fireEvent.click(change('m'));
    // The auto-repeat of the key that started it (Enter on the button) is not the answer.
    expect(press('Enter', { repeat: true })).toBe(false);
    expect(calls('settings_rebind')).toEqual([]);
    expect(within(row('m')).getByRole('status')).toBeTruthy();
  });

  test('a key that is Windows\' or moves the focus is refused with a word, and the wait goes on', async () => {
    await open();
    fireEvent.click(change('m'));

    expect(press('Tab', { code: 'Tab' })).toBe(false);
    expect(within(row('m')).getByRole('status').textContent).toBe(
      'Press the new key for m. Esc cancels. That key belongs to Windows or moves the focus, so a shortcut cannot use it. Press another key.',
    );
    expect(calls('settings_rebind')).toEqual([]);

    // The next key is the answer, and the word goes.
    press('j', { code: 'KeyJ' });
    expect(calls('settings_rebind')).toEqual([{ key: 'm', newKey: 'j' }]);
    await settle();
  });

  test('Cancel and a second press on Change end the wait', async () => {
    await open();
    fireEvent.click(change('m'));
    fireEvent.click(within(row('m')).getByRole('button', { name: 'Cancel' }));
    expect(within(row('m')).queryByRole('status')).toBeNull();

    fireEvent.click(change('m'));
    fireEvent.click(change('m'));
    expect(within(row('m')).queryByRole('status')).toBeNull();
    expect(change('m').getAttribute('aria-pressed')).toBe('false');
  });

  test('a click outside the row, or leaving the window, ends the wait: the keys are the page\'s again', async () => {
    await open();
    const detach = attachVideoInput(document.createElement('div'));
    try {
      fireEvent.click(change('m'));
      // In the row itself it does not.
      fireEvent.pointerDown(row('m'));
      expect(within(row('m')).getByRole('status')).toBeTruthy();
      fireEvent.pointerDown(searchField());
      expect(within(row('m')).queryByRole('status')).toBeNull();
      // Typing into the field is the field's.
      press('a', { code: 'KeyA' }, searchField());
      expect(forwarded()).toEqual([]);
      expect(calls('settings_rebind')).toEqual([]);

      fireEvent.click(change('m'));
      expect(within(row('m')).getByRole('status')).toBeTruthy();
      fireEvent.blur(window);
      expect(within(row('m')).queryByRole('status')).toBeNull();

      // Another row's Change moves the wait there.
      fireEvent.click(change('m'));
      fireEvent.pointerDown(change('RIGHT'));
      fireEvent.click(change('RIGHT'));
      expect(within(row('m')).queryByRole('status')).toBeNull();
      expect(within(row('RIGHT')).getByRole('status')).toBeTruthy();
    } finally {
      detach();
    }
  });

  test('what Rust refuses is said in the row, and the list stays', async () => {
    rust({
      settings_rebind: () =>
        Promise.reject({ type: 'invalid', key: 'newKey', reason: 'a key name mpv knows' }),
    });
    await open();

    fireEvent.click(change('m'));
    press('x', { code: 'KeyX' });

    const alert = await within(row('m')).findByRole('alert');
    expect(alert.textContent).toBe('mpv does not accept that key. Press another key.');
    expect(keysShown()).toEqual(['RIGHT', 'm', 'Ctrl+f', 'q', 'f', 'i', 'Ctrl+h']);
    // The row can be tried again, and the message goes with the try.
    rust();
    fireEvent.click(change('m'));
    expect(within(row('m')).queryByRole('alert')).toBeNull();
    press('y', { code: 'KeyY' });
    await waitFor(() => {
      expect(keysShown()).toContain('y');
    });
  });

  test('every refusal has its words', async () => {
    const refusals: [unknown, string][] = [
      [{ type: 'notAllowed', key: 'm' }, 'This shortcut cannot be changed.'],
      [{ type: 'invalid', key: 'key', reason: 'x' }, 'This shortcut cannot be changed.'],
      [
        { type: 'io', message: 'locked' },
        'The shortcut could not be saved. Check that the settings folder can be written to.',
      ],
      [{ type: 'unavailable' }, 'The player is not running yet. Try again in a moment.'],
      ['invalid args for command settings_rebind', 'The shortcut could not be changed.'],
    ];
    for (const [reason, text] of refusals) {
      vi.mocked(invoke).mockReset();
      rust({ settings_rebind: () => Promise.reject(reason) });
      const view = await open();
      fireEvent.click(change('m'));
      press('x', { code: 'KeyX' });
      expect((await within(row('m')).findByRole('alert')).textContent).toBe(text);
      view.unmount();
    }
  });

  test('the buttons of the row wait while Rust works on it', async () => {
    let answer: () => void = () => undefined;
    rust({
      settings_rebind: () =>
        new Promise((resolve) => {
          answer = () => {
            moveBinding('m', 'x');
            resolve(null);
          };
        }),
    });
    await open();
    fireEvent.click(change('m'));
    press('x', { code: 'KeyX' });

    expect((change('m') as HTMLButtonElement).disabled).toBe(true);
    expect((reset('m') as HTMLButtonElement).disabled).toBe(true);
    expect((change('RIGHT') as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      answer();
      await Promise.resolve();
    });
    await settle();
    expect((change('x') as HTMLButtonElement).disabled).toBe(false);
  });

  test('the focus follows a shortcut that was changed from the keyboard', async () => {
    await open();
    act(() => {
      change('m').focus();
    });
    fireEvent.click(change('m'));
    press('x', { code: 'KeyX' });
    await waitFor(() => {
      expect(keysShown()).toContain('x');
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(change('x'));
    });
  });

  test('a click with the pointer leaves nothing focused, so that Space goes to mpv', async () => {
    await open();
    const detach = attachVideoInput(document.createElement('div'));
    try {
      change('m').focus();
      fireEvent.pointerUp(change('m'));
      expect(document.activeElement).not.toBe(change('m'));
    } finally {
      detach();
    }
  });
});

describe('reset', () => {
  test('puts a key back with Rust: a plugin\'s binding too', async () => {
    await open();
    fireEvent.click(reset('i'));

    expect(calls('settings_reset_binding')).toEqual([{ key: 'i' }]);
    await waitFor(() => {
      expect(pageStatus()?.textContent).toBe('Shortcut i reset.');
    });
    // The list was read again.
    expect(sent('settings_bindings')).toHaveLength(2);
    expect(headings()).toContain('stats');
  });

  test('a key that was moved is back where it was, and a key made up is Disabled like any silenced key', async () => {
    await open();
    fireEvent.click(change('Ctrl+f'));
    press('g', { ctrlKey: true, code: 'KeyG' });
    await waitFor(() => {
      expect(keysShown()).toContain('Ctrl+g');
    });
    expect(within(row('Ctrl+f')).getByText('Disabled')).toBeTruthy();

    // Reset the key the binding went to: it is made up, so there is nothing to go back to, and it does nothing.
    fireEvent.click(reset('Ctrl+g'));
    await waitFor(() => {
      expect(within(row('Ctrl+g')).getByText('Disabled')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Change shortcut Ctrl+g' })).toBeNull();
    expect(calls('settings_reset_binding')).toEqual([{ key: 'Ctrl+g' }]);

    // The key the binding came from is reset to what it was.
    fireEvent.click(reset('Ctrl+f'));
    await waitFor(() => {
      expect(within(row('Ctrl+f')).getByText('My fullscreen')).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Change shortcut Ctrl+f' })).toBeTruthy();
  });

  test('says when Rust refuses', async () => {
    rust({ settings_reset_binding: () => Promise.reject({ type: 'io', message: 'locked' }) });
    await open();
    fireEvent.click(reset('f'));
    expect((await within(row('f')).findByRole('alert')).textContent).toBe(
      'The shortcut could not be saved. Check that the settings folder can be written to.',
    );
  });

  test('ends a wait that was on', async () => {
    await open();
    fireEvent.click(change('m'));
    fireEvent.click(reset('m'));
    expect(within(row('m')).queryByRole('status')).toBeNull();
    await settle();
  });
});

describe('the keyboard', () => {
  test('the list is one stop for Tab, and the arrows move through the buttons and are handled', async () => {
    await open();
    const detach = attachVideoInput(document.createElement('div'));
    try {
      const stops = () =>
        Array.from(document.querySelectorAll<HTMLButtonElement>('[data-rove-id]')).filter(
          (button) => button.tabIndex === 0,
        );
      // The first button of the first row.
      expect(stops()).toEqual([change('RIGHT')]);

      act(() => {
        change('RIGHT').focus();
      });
      // Right: along the row. Down: the same button of the next row. Both are the list's keys.
      expect(fireEvent.keyDown(change('RIGHT'), { key: 'ArrowRight' })).toBe(false);
      expect(document.activeElement).toBe(reset('RIGHT'));
      expect(stops()).toEqual([reset('RIGHT')]);
      expect(fireEvent.keyDown(reset('RIGHT'), { key: 'ArrowDown' })).toBe(false);
      expect(document.activeElement).toBe(reset('m'));
      expect(fireEvent.keyDown(reset('m'), { key: 'ArrowLeft' })).toBe(false);
      expect(document.activeElement).toBe(change('m'));
      expect(fireEvent.keyDown(change('m'), { key: 'ArrowUp' })).toBe(false);
      expect(document.activeElement).toBe(change('RIGHT'));
      // The edge: nothing moves, and the key is still the list's (the arrows seek in mpv).
      expect(fireEvent.keyDown(change('RIGHT'), { key: 'ArrowUp' })).toBe(false);
      expect(fireEvent.keyDown(change('RIGHT'), { key: 'ArrowLeft' })).toBe(false);
      expect(document.activeElement).toBe(change('RIGHT'));

      // A silenced row has Reset only: down from Change lands on it.
      act(() => {
        change('Ctrl+f').focus();
      });
      fireEvent.keyDown(change('Ctrl+f'), { key: 'ArrowDown' });
      expect(document.activeElement).toBe(reset('q'));

      // Home and End: the first and the last row, in the column the focus was in (the first, in a row with one button).
      fireEvent.keyDown(reset('q'), { key: 'End' });
      expect(document.activeElement).toBe(change('Ctrl+h'));
      fireEvent.keyDown(change('Ctrl+h'), { key: 'Home' });
      expect(document.activeElement).toBe(change('RIGHT'));
      expect(forwarded()).toEqual([]);
    } finally {
      detach();
    }
  });

  test('a button that is not the list\'s, and the keys with a modifier, are left alone', async () => {
    await open();
    expect(fireEvent.keyDown(change('m'), { key: 'ArrowDown', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(change('m'), { key: 'a' })).toBe(true);
    expect(fireEvent.keyDown(searchField(), { key: 'ArrowDown' })).toBe(true);
  });

  test('the buttons are named by the shortcut, and the group is named by its heading', async () => {
    await open();
    expect(change('m').textContent).toBe('Change');
    expect(reset('m').textContent).toBe('Reset');
    expect(screen.getByRole('region', { name: 'Custom' })).toBeTruthy();
  });
});

describe('in Czech', () => {
  test('the texts and the groups are in Czech', async () => {
    setLanguage('cs');
    render(<Shortcuts />);
    await screen.findByRole('heading', { level: 3, name: 'Kaleido' });
    expect(headings()).toEqual(['Kaleido', 'Vlastní', 'mpv', 'stats', 'thumbfast']);
    expect(within(row('q')).getByText('Vypnuto')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Změnit zkratku m' }));
    expect(within(row('m')).getByRole('status').textContent).toBe(
      'Stiskni novou klávesu pro m. Esc změnu zruší.',
    );
  });
});
