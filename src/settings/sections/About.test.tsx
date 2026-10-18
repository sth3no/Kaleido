import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../../i18n';
import { attachVideoInput } from '../../input/forward';
import type { License } from '../../ipc/types';
import About from './About';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn() }));

const DIAGNOSTICS = [
  'Kaleido: 0.1.0',
  'libmpv: mpv v0.41.0-241-gaccb7b2821',
  'FFmpeg: N-118000-g1234567',
  'Windows: 10.0.26200',
  'GPU: NVIDIA GeForce RTX 4070',
  'Scripts: none',
  '',
].join('\n');

const LICENSES: License[] = [
  { name: 'libmpv', version: 'git-accb7b2821', license: 'GPL-3.0-or-later', url: 'https://github.com/shinchiro/mpv-winbuild-cmake' },
  { name: 'thumbfast', version: '0f711de', license: 'MPL-2.0', url: 'https://github.com/po5/thumbfast' },
  { name: 'zustand', version: '5.0.15', license: 'MIT', url: 'https://github.com/pmndrs/zustand' },
  { name: 'serde', version: '1.0.200', license: 'MIT OR Apache-2.0', url: 'https://serde.rs' },
];

type Answers = Record<string, (args: unknown) => unknown>;

function rust(answers: Answers = {}) {
  const all: Answers = {
    system_diagnostics: () => DIAGNOSTICS,
    system_licenses: () => LICENSES,
    system_copy_diagnostics: () => null,
    system_open_logs: () => null,
    system_open_source: () => null,
    ...answers,
  };
  vi.mocked(invoke).mockImplementation(((command: string, args?: unknown) =>
    Promise.resolve(all[command]?.(args) ?? null)) as unknown as typeof invoke);
}

const sent = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);
const forwarded = () => sent('player_input');

/** Lets the answers that are on their way arrive, and what they set in motion run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The page, once the versions and the licenses are in. */
async function open() {
  const view = render(<About />);
  await screen.findByText('Total: 4');
  await settle();
  return view;
}

/** The version a name has in the list of versions. */
const versionOf = (name: string) => {
  const term = screen.getByText(name, { selector: 'dt' });
  return term.nextElementSibling?.textContent;
};
const licenseNames = () =>
  Array.from(document.querySelectorAll('li')).map((item) => item.firstElementChild?.firstChild?.textContent);
const searchField = () => screen.getByRole('searchbox', { name: 'Search licenses' }) as HTMLInputElement;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(getVersion).mockReset();
  vi.mocked(getVersion).mockResolvedValue('0.1.0');
  rust();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  setLanguage('en');
});

describe('the versions', () => {
  test('about shows versions and its buttons call Rust', async () => {
    await open();

    // Kaleido's own version from Tauri, libmpv and FFmpeg from the diagnostics.
    expect(versionOf('Kaleido')).toBe('0.1.0');
    expect(versionOf('libmpv')).toBe('mpv v0.41.0-241-gaccb7b2821');
    expect(versionOf('FFmpeg')).toBe('N-118000-g1234567');
    expect(getVersion).toHaveBeenCalledTimes(1);
    expect(sent('system_diagnostics')).toHaveLength(1);
    // Reading them does not copy anything.
    expect(sent('system_copy_diagnostics')).toEqual([]);

    // The logs folder.
    fireEvent.click(button('Open logs folder'));
    expect(sent('system_open_logs')).toEqual([['system_open_logs']]);

    // The diagnostics on the clipboard, which the page confirms.
    fireEvent.click(button('Copy diagnostics'));
    expect(sent('system_copy_diagnostics')).toEqual([['system_copy_diagnostics']]);
    // In the page's status line, which a screen reader announces.
    const confirmation = await screen.findByText('The diagnostics are on the clipboard.');
    expect(confirmation.getAttribute('role')).toBe('status');
    expect(screen.queryByRole('alert')).toBeNull();

    // The way to the sources, by the name of the page: Rust has the addresses.
    fireEvent.click(button('Releases and sources of Kaleido'));
    fireEvent.click(button('Sources of the libmpv build'));
    expect(sent('system_open_source')).toEqual([
      ['system_open_source', { which: 'kaleido' }],
      ['system_open_source', { which: 'libmpv' }],
    ]);
  });

  test('a version that cannot be found out says so', async () => {
    vi.mocked(getVersion).mockRejectedValue(new Error('no app'));
    rust({ system_diagnostics: () => 'Kaleido: 0.1.0\nlibmpv: unknown\nFFmpeg: unknown\n' });
    await open();

    expect(versionOf('Kaleido')).toBe('Unknown');
    expect(versionOf('libmpv')).toBe('Unknown');
    expect(versionOf('FFmpeg')).toBe('Unknown');
    expect(console.warn).toHaveBeenCalled();
  });

  test('the diagnostics that cannot be read leave the versions unknown, and the rest of the page works', async () => {
    rust({ system_diagnostics: () => Promise.reject('the player is not running') });
    await open();
    expect(versionOf('Kaleido')).toBe('0.1.0');
    expect(versionOf('libmpv')).toBe('Unknown');
    expect(versionOf('FFmpeg')).toBe('Unknown');
    expect(button('Open logs folder')).toBeTruthy();
  });

  test('says it is loading until the versions are in', async () => {
    let answer: (value: unknown) => void = () => undefined;
    rust({
      system_diagnostics: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    render(<About />);
    expect(versionOf('Kaleido')).toBe('Loading…');
    expect(versionOf('libmpv')).toBe('Loading…');

    await act(async () => {
      answer(DIAGNOSTICS);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(versionOf('libmpv')).toBe('mpv v0.41.0-241-gaccb7b2821');
    });
    expect(versionOf('Kaleido')).toBe('0.1.0');
  });
});

describe('the buttons', () => {
  test('copying the diagnostics can fail, and the page shows why', async () => {
    rust({ system_copy_diagnostics: () => Promise.reject('Clipboard is in use by another program') });
    await open();
    // Pressed from the keyboard: the button has the focus.
    act(() => {
      button('Copy diagnostics').focus();
    });

    fireEvent.click(button('Copy diagnostics'));
    // It waits, and says so; a second press does nothing meanwhile. It is not disabled: the browser
    // takes the focus away from a disabled button (jsdom does not), and the keyboard user is lost.
    expect(button('Copy diagnostics').getAttribute('aria-disabled')).toBe('true');
    expect(button('Copy diagnostics').disabled).toBe(false);
    fireEvent.click(button('Copy diagnostics'));
    expect(sent('system_copy_diagnostics')).toHaveLength(1);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'The diagnostics could not be copied: Clipboard is in use by another program',
    );
    expect(button('Copy diagnostics').getAttribute('aria-disabled')).toBe('false');
    // The focus never left it (a disabled button would have dropped it to the page).
    expect(document.activeElement).toBe(button('Copy diagnostics'));
    // No success is claimed.
    expect(screen.queryByText('The diagnostics are on the clipboard.')).toBeNull();
    expect(console.warn).toHaveBeenCalled();

    // Tried again and it works: the error goes and the success is told.
    rust();
    fireEvent.click(button('Copy diagnostics'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await screen.findByText('The diagnostics are on the clipboard.')).toBeTruthy();
  });

  test('a failure without a reason still says it failed', async () => {
    rust({ system_copy_diagnostics: () => Promise.reject(undefined) });
    await open();
    fireEvent.click(button('Copy diagnostics'));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The diagnostics could not be copied: Something went wrong.',
    );
  });

  test('a button that cannot even ask Rust says so', async () => {
    rust({
      system_open_logs: () => Promise.reject('command not found'),
      system_open_source: () => Promise.reject('command not found'),
    });
    await open();

    fireEvent.click(button('Open logs folder'));
    expect((await screen.findByRole('alert')).textContent).toBe('It could not be opened.');

    // Another press takes the message away first.
    fireEvent.click(button('Releases and sources of Kaleido'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((await screen.findByRole('alert')).textContent).toBe('It could not be opened.');
  });

  test('do not stay focused after the pointer, so that Space goes to mpv', async () => {
    await open();
    for (const name of ['Open logs folder', 'Copy diagnostics', 'Sources of the libmpv build']) {
      button(name).focus();
      fireEvent.pointerUp(button(name));
      expect(document.activeElement, name).not.toBe(button(name));
    }
  });
});

describe('the notes', () => {
  test('says that a screenshot a plugin takes has the glass in it', async () => {
    await open();
    expect(
      screen.getByText(
        'A screenshot that a plugin takes with the screenshot command includes the glass. Screenshots from Kaleido’s own shortcuts do not.',
      ),
    ).toBeTruthy();
  });

  test('says where the sources are, and that the license texts come later', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 3, name: 'Sources' })).toBeTruthy();
    expect(screen.getByText(/GPL-3\.0-or-later\. The libmpv it ships is a GPL build/)).toBeTruthy();
    expect(screen.getByText(/The full license texts come in a later version/)).toBeTruthy();
  });
});

describe('the licenses', () => {
  test('are listed with their name, version, license and address, in the order Rust gives them', async () => {
    await open();
    const list = screen.getByRole('region', { name: 'List of licenses' });
    expect(licenseNames()).toEqual(['libmpv', 'thumbfast', 'zustand', 'serde']);
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    const first = within(list).getAllByRole('listitem')[0];
    expect(first?.textContent).toContain('git-accb7b2821');
    expect(first?.textContent).toContain('GPL-3.0-or-later');
    expect(first?.textContent).toContain('https://github.com/shinchiro/mpv-winbuild-cmake');
    expect(screen.getByText('Total: 4')).toBeTruthy();
    expect(sent('system_licenses')).toHaveLength(1);
    // The addresses are text: the UI opens no address of its own.
    expect(within(list).queryAllByRole('link')).toEqual([]);
  });

  test('are searched by name, version, license and address', async () => {
    await open();

    fireEvent.change(searchField(), { target: { value: 'mit' } });
    expect(licenseNames()).toEqual(['zustand', 'serde']);
    expect(screen.getByText('Found: 2')).toBeTruthy();

    fireEvent.change(searchField(), { target: { value: 'mit apache' } });
    expect(licenseNames()).toEqual(['serde']);

    fireEvent.change(searchField(), { target: { value: '0f711' } });
    expect(licenseNames()).toEqual(['thumbfast']);

    fireEvent.change(searchField(), { target: { value: 'zzz' } });
    expect(licenseNames()).toEqual([]);
    expect(screen.getByText('No license matches “zzz”.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'List of licenses' })).toBeNull();

    fireEvent.change(searchField(), { target: { value: '' } });
    expect(licenseNames()).toHaveLength(4);
    expect(screen.getByText('Total: 4')).toBeTruthy();
  });

  test('Esc clears the search and is handled; with nothing typed it is not the search\'s', async () => {
    await open();
    fireEvent.change(searchField(), { target: { value: 'mit' } });
    expect(fireEvent.keyDown(searchField(), { key: 'Escape' })).toBe(false);
    expect(searchField().value).toBe('');
    expect(fireEvent.keyDown(searchField(), { key: 'Escape' })).toBe(true);
  });

  test('the list scrolls with the keys, which mpv does not also get', async () => {
    await open();
    const detach = attachVideoInput(document.createElement('div'));
    try {
      const list = screen.getByRole('region', { name: 'List of licenses' });
      // It takes the focus, so that a keyboard user can get to it.
      expect(list.tabIndex).toBe(0);
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
      Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
      act(() => {
        list.focus();
      });

      expect(fireEvent.keyDown(list, { key: 'ArrowDown', code: 'ArrowDown' })).toBe(false);
      expect(list.scrollTop).toBe(40);
      expect(fireEvent.keyDown(list, { key: 'ArrowUp', code: 'ArrowUp' })).toBe(false);
      expect(list.scrollTop).toBe(0);
      expect(fireEvent.keyDown(list, { key: 'PageDown', code: 'PageDown' })).toBe(false);
      expect(list.scrollTop).toBe(180);
      expect(fireEvent.keyDown(list, { key: 'PageUp', code: 'PageUp' })).toBe(false);
      expect(list.scrollTop).toBe(0);
      expect(fireEvent.keyDown(list, { key: 'End', code: 'End' })).toBe(false);
      expect(list.scrollTop).toBe(1000);
      expect(fireEvent.keyDown(list, { key: 'Home', code: 'Home' })).toBe(false);
      expect(list.scrollTop).toBe(0);
      expect(forwarded()).toEqual([]);

      // A key it has nothing to do with goes on to mpv.
      fireEvent.keyDown(list, { key: 'ArrowLeft', code: 'ArrowLeft' });
      expect(forwarded()).toHaveLength(1);
    } finally {
      detach();
    }
  });

  test('a list that cannot be read is said, and can be read again', async () => {
    rust({ system_licenses: () => Promise.reject('no files') });
    render(<About />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The list could not be read.');
    expect(screen.queryByRole('searchbox')).toBeNull();
    // The rest of the page is there.
    expect(button('Open logs folder')).toBeTruthy();

    rust();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Total: 4')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('an installation with no license files has an empty list, not an error', async () => {
    rust({ system_licenses: () => [] });
    render(<About />);
    expect(await screen.findByText('Total: 0')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'List of licenses' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('in Czech', () => {
  test('the texts are in Czech, and the versions are the same', async () => {
    setLanguage('cs');
    render(<About />);
    await screen.findByText('Celkem: 4');
    await settle();

    expect(screen.getByRole('button', { name: 'Otevřít složku s logy' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zkopírovat diagnostiku' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Vydání a zdroje Kaleida' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zdroje buildu libmpv' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Licence třetích stran' })).toBeTruthy();
    expect(versionOf('libmpv')).toBe('mpv v0.41.0-241-gaccb7b2821');
  });
});
