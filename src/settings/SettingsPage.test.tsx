import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../i18n';
import { attachVideoInput } from '../input/forward';
import type { Settings } from '../ipc/types';
import { MINI } from '../surface/mini';
import { DEFAULT_APPEARANCE } from '../theme/tokens';
import SettingsPage from './SettingsPage';
import { useSettingsStore } from './store';

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
  playback: { openWhilePlaying: 'replace' },
};

/** What `settings_get_mpv` gives: the values of mpv's defaults, as mpv.conf and the player have them. */
const MPV: Record<string, string | null> = {
  hwdec: 'auto-safe',
  'autocreate-playlist': 'filter',
  'save-position-on-quit': 'yes',
  'sub-font': 'sans-serif',
  'sub-font-size': '55',
  'sub-color': '#FFFFFFFF',
  'sub-border-color': '#FF000000',
  'sub-border-size': '3',
  'sub-back-color': '#00000000',
  slang: 'cs,en',
  'audio-device': 'auto',
  volume: '100',
  'volume-max': '130',
  alang: 'cs,en',
  deinterlace: 'auto',
  'tone-mapping': 'auto',
  'hdr-compute-peak': 'auto',
  profile: null,
  'glsl-shaders': '',
};

const DEVICES = [
  { name: 'auto', description: 'Autoselect device' },
  { name: 'wasapi/{0.0.0.00000000}.{abc}', description: 'Speakers (Realtek)' },
];

type Answers = Record<string, (args: unknown) => unknown>;

/** How Rust answers the commands; `answers` replaces some. */
function rust(answers: Answers = {}) {
  const all: Answers = {
    settings_get: () => SETTINGS,
    settings_get_mpv: () => MPV,
    settings_set_mpv: () => null,
    settings_set: () => SETTINGS,
    settings_audio_devices: () => DEVICES,
    settings_list_shaders: () => ['Anime4K.glsl', 'ravu.hook'],
    system_fonts: () => ['Arial', 'Segoe UI'],
    ...answers,
  };
  vi.mocked(invoke).mockImplementation(((command: string, args?: unknown) =>
    Promise.resolve(all[command]?.(args) ?? null)) as unknown as typeof invoke);
}

const sent = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

/** The arguments of the `settings_set_mpv` calls: the key and the value. */
const mpvWrites = () => sent('settings_set_mpv').map(([, args]) => args);

const nav = () => within(screen.getByRole('navigation', { name: 'Settings sections' }));
const sectionButton = (name: string) => nav().getByRole('button', { name });
/** The button that opens the list of a select, font or device field: named by its label and its value. */
const picker = (label: string) =>
  screen.getByRole('button', { name: new RegExp(`^${label}`) }) as HTMLButtonElement;
const searchField = () => screen.getByRole('searchbox', { name: 'Search settings' }) as HTMLInputElement;
/** The page's own status line (an `<output>` is a status too). */
const searchStatus = () => document.querySelector('p[role="status"]');
/** The settings on the page, by id. */
const shownIds = () =>
  Array.from(document.querySelectorAll('[data-setting]')).map((row) => row.getAttribute('data-setting'));
const sectionHeadings = () =>
  screen.queryAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);

/** What a control's `aria-describedby` points at, as text. */
const description = (control: HTMLElement) =>
  (control.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent);

/** The page, once the settings are read and the fields can be changed. */
async function open() {
  const view = render(<SettingsPage />);
  await waitFor(() => {
    const remember = screen.getByRole('switch', { name: 'Remember position' }) as HTMLButtonElement;
    expect(remember.disabled).toBe(false);
  });
  return view;
}

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

/** What was passed on to mpv. */
const forwarded = () =>
  vi.mocked(invoke).mock.calls.filter(([command]) => command === 'player_input');

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  events.handlers.clear();
  vi.mocked(invoke).mockReset();
  rust();
  // A change Rust refuses is logged, and some tests make it.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  setLanguage('en');
});

describe('the page', () => {
  test('lists the sections with the first open, and a title and a search', async () => {
    await open();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings');
    const items = nav().getAllByRole('button');
    expect(items.map((item) => item.textContent)).toEqual([
      'Playback',
      'Subtitles',
      'Audio',
      'Video',
      'Appearance',
      'Shortcuts',
      'About',
    ]);
    expect(items[0]?.getAttribute('aria-current')).toBe('true');
    expect(items.filter((item) => item.hasAttribute('aria-current'))).toHaveLength(1);
    expect(sectionHeadings()).toEqual(['Playback']);
    expect(searchField().placeholder).toBe('Search settings');
    expect(shownIds()).toEqual([
      'hwdec',
      'autocreate-playlist',
      'save-position-on-quit',
      'playback.openWhilePlaying',
    ]);
  });

  test('shows the values Rust has', async () => {
    await open();
    expect(picker('Hardware decoding').textContent).toBe('Automatic (safe)');
    expect(screen.getByRole('switch', { name: 'Playlist from folder' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('switch', { name: 'Remember position' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(picker('When a file is opened during playback').textContent).toBe('Replace what is playing');
  });

  test('opening a section shows its settings: subtitles, audio and video', async () => {
    await open();

    fireEvent.click(sectionButton('Subtitles'));
    expect(shownIds()).toEqual([
      'sub-font',
      'sub-font-size',
      'sub-color',
      'sub-border-color',
      'sub-border-size',
      'sub-back-color',
      'slang',
    ]);
    // The values of mpv.conf, in the field of each.
    expect((screen.getByRole('slider', { name: 'Subtitle size' }) as HTMLInputElement).value).toBe('55');
    expect((screen.getByRole('textbox', { name: 'Subtitle color' }) as HTMLInputElement).value).toBe(
      '#FFFFFFFF',
    );
    expect((screen.getByRole('textbox', { name: 'Preferred subtitle languages' }) as HTMLInputElement).value).toBe(
      'cs, en',
    );

    fireEvent.click(sectionButton('Audio'));
    expect(shownIds()).toEqual(['audio-device', 'volume', 'volume-max', 'alang']);
    expect((screen.getByRole('slider', { name: 'Maximum volume' }) as HTMLInputElement).value).toBe('130');

    fireEvent.click(sectionButton('Video'));
    expect(shownIds()).toEqual([
      'deinterlace',
      'tone-mapping',
      'hdr-compute-peak',
      'profile',
      'glsl-shaders',
    ]);
    expect(picker('Deinterlacing').textContent).toBe('Automatic');
    // No profile is "None".
    expect(picker('Quality preset').textContent).toBe('None');
  });

  test('appearance, shortcuts and about are listed with a heading and nothing else yet', async () => {
    await open();
    for (const name of ['Appearance', 'Shortcuts', 'About']) {
      fireEvent.click(sectionButton(name));
      const region = screen.getByRole('region', { name });
      expect(within(region).getByRole('heading', { level: 2 }).textContent).toBe(name);
      expect(region.children).toHaveLength(1);
      expect(shownIds()).toEqual([]);
    }
  });

  test('listens for settings:changed before it reads, and keeps room for the mini player', async () => {
    const { container } = render(<SettingsPage />);
    expect(events.handlers.has('settings:changed')).toBe(true);
    expect(
      (container.firstElementChild as HTMLElement).style.getPropertyValue('--settings-mini-reserve'),
    ).toBe(`${MINI.w}px`);
    await waitFor(() => {
      expect(useSettingsStore.getState().status).toBe('ready');
    });
  });

  test('the settings that cannot be read are said, and can be read again', async () => {
    rust({ settings_get: () => Promise.reject('no settings') });
    render(<SettingsPage />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The settings could not be read.');
    // Nothing is shown as a value that Rust has not given.
    expect(screen.queryByRole('switch', { name: 'Remember position' })).toBeNull();
    expect(shownIds()).toEqual([]);

    rust();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect((screen.getByRole('switch', { name: 'Remember position' }) as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('while the player is not up the mpv options are not shown as values, and can be read again', async () => {
    // Rust answers an empty map until the player is up.
    rust({ settings_get_mpv: () => ({}) });
    render(<SettingsPage />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The player is not ready yet, so its settings cannot be shown.');
    // No slider at its minimum, no list with nothing chosen: the rows of the mpv options are not there.
    expect(screen.queryByRole('switch', { name: 'Remember position' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Hardware decoding/ })).toBeNull();
    // Kaleido's own setting does not need the player.
    expect(picker('When a file is opened during playback').disabled).toBe(false);
    fireEvent.click(sectionButton('Audio'));
    expect(shownIds()).toEqual([]);
    fireEvent.click(sectionButton('Playback'));

    rust();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect((screen.getByRole('switch', { name: 'Remember position' }) as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(picker('Hardware decoding').textContent).toBe('Automatic (safe)');
  });
});

describe('saving', () => {
  test('changing a field calls settingsSetMpv with the value', async () => {
    await open();

    const remember = screen.getByRole('switch', { name: 'Remember position' });
    fireEvent.click(remember);
    expect(mpvWrites()).toEqual([{ key: 'save-position-on-quit', value: 'no' }]);
    // Shown at once, and kept when Rust agrees.
    expect(remember.getAttribute('aria-checked')).toBe('false');
    await waitFor(() => {
      expect(useSettingsStore.getState().mpv['save-position-on-quit']).toBe('no');
    });
    expect(remember.getAttribute('aria-checked')).toBe('false');

    // "Playlist from folder" is autocreate-playlist: filter, or no.
    const folder = screen.getByRole('switch', { name: 'Playlist from folder' });
    fireEvent.click(folder);
    expect(mpvWrites().at(-1)).toEqual({ key: 'autocreate-playlist', value: 'no' });
    await waitFor(() => {
      expect(useSettingsStore.getState().mpv['autocreate-playlist']).toBe('no');
    });
    fireEvent.click(folder);
    expect(mpvWrites().at(-1)).toEqual({ key: 'autocreate-playlist', value: 'filter' });

    fireEvent.click(picker('Hardware decoding'));
    fireEvent.click(screen.getByRole('option', { name: 'Off (software)' }));
    expect(mpvWrites().at(-1)).toEqual({ key: 'hwdec', value: 'no' });
    await waitFor(() => {
      expect(picker('Hardware decoding').textContent).toBe('Off (software)');
    });
  });

  test('a field with no value saves the word, and "none" takes the option out (null)', async () => {
    await open();
    fireEvent.click(sectionButton('Video'));

    fireEvent.click(picker('Quality preset'));
    fireEvent.click(screen.getByRole('option', { name: 'High quality' }));
    expect(mpvWrites().at(-1)).toEqual({ key: 'profile', value: 'high-quality' });
    await waitFor(() => {
      expect(picker('Quality preset').textContent).toBe('High quality');
    });

    fireEvent.click(picker('Quality preset'));
    fireEvent.click(screen.getByRole('option', { name: 'None' }));
    expect(mpvWrites().at(-1)).toEqual({ key: 'profile', value: null });
    await waitFor(() => {
      expect(useSettingsStore.getState().mpv.profile).toBeNull();
    });
  });

  test('the tone mapping saves mpv\'s word, with its dot', async () => {
    await open();
    fireEvent.click(sectionButton('Video'));
    fireEvent.click(picker('HDR tone mapping'));
    fireEvent.click(screen.getByRole('option', { name: 'BT.2390' }));
    expect(mpvWrites().at(-1)).toEqual({ key: 'tone-mapping', value: 'bt.2390' });
  });

  test('the text fields save when they are left, the font from its list', async () => {
    await open();
    fireEvent.click(sectionButton('Subtitles'));

    const color = screen.getByRole('textbox', { name: 'Subtitle color' });
    fireEvent.change(color, { target: { value: 'ffcc00' } });
    expect(mpvWrites()).toEqual([]);
    fireEvent.blur(color);
    expect(mpvWrites()).toEqual([{ key: 'sub-color', value: '#FFCC00' }]);

    const languages = screen.getByRole('textbox', { name: 'Preferred subtitle languages' });
    fireEvent.change(languages, { target: { value: 'de; FR' } });
    fireEvent.keyDown(languages, { key: 'Enter' });
    expect(mpvWrites().at(-1)).toEqual({ key: 'slang', value: 'de,fr' });

    await waitFor(() => {
      expect((picker('Subtitle font') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(picker('Subtitle font'));
    fireEvent.click(screen.getByRole('option', { name: 'Segoe UI' }));
    expect(mpvWrites().at(-1)).toEqual({ key: 'sub-font', value: 'Segoe UI' });
  });

  test('the audio device saves the name mpv gives it, not the text on the screen', async () => {
    await open();
    fireEvent.click(sectionButton('Audio'));
    await waitFor(() => {
      expect(picker('Audio device').textContent).toBe('Autoselect device');
    });
    fireEvent.click(picker('Audio device'));
    fireEvent.click(screen.getByRole('option', { name: 'Speakers (Realtek)' }));
    expect(mpvWrites().at(-1)).toEqual({ key: 'audio-device', value: 'wasapi/{0.0.0.00000000}.{abc}' });
  });

  test('a patch carries only the changed field', async () => {
    rust({ settings_set: () => ({ ...SETTINGS, playback: { openWhilePlaying: 'append' } }) });
    await open();

    fireEvent.click(picker('When a file is opened during playback'));
    fireEvent.click(screen.getByRole('option', { name: 'Add to the playlist' }));

    // Not the whole of the settings echoed back (Rust refuses a key it does not know).
    expect(sent('settings_set')).toEqual([
      ['settings_set', { patch: { playback: { openWhilePlaying: 'append' } } }],
    ]);
    // Nothing of mpv.conf is touched.
    expect(sent('settings_set_mpv')).toEqual([]);
    await waitFor(() => {
      expect(picker('When a file is opened during playback').textContent).toBe('Add to the playlist');
    });
    expect(useSettingsStore.getState().kaleido?.playback.openWhilePlaying).toBe('append');
  });

  test('the shaders are saved as ~~/shaders/<name> entries joined by ;', async () => {
    rust({ settings_get_mpv: () => ({ ...MPV, 'glsl-shaders': '~~/shaders/ravu.hook' }) });
    await open();
    fireEvent.click(sectionButton('Video'));

    const anime = await screen.findByRole('checkbox', { name: 'Anime4K.glsl' });
    expect((screen.getByRole('checkbox', { name: 'ravu.hook' }) as HTMLInputElement).checked).toBe(true);
    expect((anime as HTMLInputElement).checked).toBe(false);

    // Turned on after the one that is on.
    fireEvent.click(anime);
    expect(mpvWrites().at(-1)).toEqual({
      key: 'glsl-shaders',
      value: '~~/shaders/ravu.hook;~~/shaders/Anime4K.glsl',
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'ravu.hook' }));
    expect(mpvWrites().at(-1)).toEqual({ key: 'glsl-shaders', value: '~~/shaders/Anime4K.glsl' });

    // None left: the option leaves mpv.conf.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Anime4K.glsl' }));
    expect(mpvWrites().at(-1)).toEqual({ key: 'glsl-shaders', value: null });
  });

  test('a slider is saved where the pointer is let go, once', async () => {
    await open();
    fireEvent.click(sectionButton('Audio'));
    const slider = screen.getByRole('slider', { name: 'Maximum volume' });

    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '200' } });
    fireEvent.change(slider, { target: { value: '250' } });
    // Nothing on the way, but the number moves.
    expect(mpvWrites()).toEqual([]);
    expect(slider.getAttribute('aria-valuetext')).toBe('250%');

    fireEvent.pointerUp(slider);
    expect(mpvWrites()).toEqual([{ key: 'volume-max', value: '250' }]);
    await waitFor(() => {
      expect(useSettingsStore.getState().mpv['volume-max']).toBe('250');
    });
    expect(slider.getAttribute('aria-valuetext')).toBe('250%');
  });

  test('a step of a slider with the keyboard is saved, and a held key is saved at the end', async () => {
    await open();
    fireEvent.click(sectionButton('Subtitles'));
    const slider = screen.getByRole('slider', { name: 'Subtitle size' });

    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.change(slider, { target: { value: '56' } });
    fireEvent.change(slider, { target: { value: '57' } });
    fireEvent.change(slider, { target: { value: '58' } });
    expect(mpvWrites()).toEqual([{ key: 'sub-font-size', value: '56' }]);
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(mpvWrites()).toEqual([
      { key: 'sub-font-size', value: '56' },
      { key: 'sub-font-size', value: '58' },
    ]);
  });
});

describe('a refusal', () => {
  test('a rejection from Rust shows inline and restores the value', async () => {
    rust({ settings_set_mpv: () => Promise.reject({ type: 'io', message: 'disk full' }) });
    await open();

    const remember = screen.getByRole('switch', { name: 'Remember position' });
    expect(remember.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(remember);

    // At the field, as an alert that describes it.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'The setting could not be saved. Check that the settings folder can be written to.',
    );
    expect(remember.getAttribute('aria-describedby')).toContain(alert.id);
    expect(alert.closest('[data-setting]')?.getAttribute('data-setting')).toBe('save-position-on-quit');
    // The value it had.
    expect(remember.getAttribute('aria-checked')).toBe('true');
    expect(useSettingsStore.getState().mpv['save-position-on-quit']).toBe('yes');
  });

  test('a select goes back to the option it had', async () => {
    rust({ settings_set_mpv: () => Promise.reject({ type: 'notAllowed', key: 'hwdec' }) });
    await open();

    fireEvent.click(picker('Hardware decoding'));
    fireEvent.click(screen.getByRole('option', { name: 'Off (software)' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Kaleido does not accept that value.');
    expect(picker('Hardware decoding').textContent).toBe('Automatic (safe)');
  });

  test('a value that is no good is told in the words of its field, and the text is restored', async () => {
    rust({
      settings_set_mpv: () =>
        Promise.reject({ type: 'invalid', key: 'slang', reason: 'language codes such as cs,en' }),
    });
    await open();
    fireEvent.click(sectionButton('Subtitles'));

    const field = screen.getByRole('textbox', { name: 'Preferred subtitle languages' }) as HTMLInputElement;
    // Looks right to the field, so it is sent; Rust says no, and the text goes back.
    fireEvent.change(field, { target: { value: 'de' } });
    fireEvent.blur(field);
    expect(mpvWrites()).toEqual([{ key: 'slang', value: 'de' }]);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Use language codes of two or three letters, such as cs,en.');
    expect(field.value).toBe('cs, en');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toContain(alert.id);
  });

  test('a list of languages with something in it that is no code is not sent, and the text stays', async () => {
    await open();
    fireEvent.click(sectionButton('Subtitles'));
    const field = screen.getByRole('textbox', { name: 'Preferred subtitle languages' }) as HTMLInputElement;

    fireEvent.change(field, { target: { value: 'czech' } });
    fireEvent.blur(field);

    // Not sent; the message is at the field, the text is still there to be corrected.
    expect(mpvWrites()).toEqual([]);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Use language codes of two or three letters, such as cs,en.');
    expect(field.value).toBe('czech');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toContain(alert.id);

    // Typing takes the message away; the corrected list is sent.
    fireEvent.change(field, { target: { value: 'cs' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(field.getAttribute('aria-invalid')).toBeNull();
    fireEvent.blur(field);
    expect(mpvWrites()).toEqual([{ key: 'slang', value: 'cs' }]);
  });

  test('a colour that is no colour is not sent, is said at the field, and can be corrected', async () => {
    await open();
    fireEvent.click(sectionButton('Subtitles'));
    const field = screen.getByRole('textbox', { name: 'Subtitle color' }) as HTMLInputElement;

    for (const typed of ['red', '#12']) {
      fireEvent.change(field, { target: { value: typed } });
      fireEvent.blur(field);
      expect(screen.getByRole('alert').textContent).toBe('Use #RRGGBB or #AARRGGBB.');
      expect(field.value).toBe(typed);
      expect(field.getAttribute('aria-invalid')).toBe('true');
    }
    expect(mpvWrites()).toEqual([]);

    fireEvent.change(field, { target: { value: 'ffcc00' } });
    fireEvent.blur(field);
    expect(mpvWrites()).toEqual([{ key: 'sub-color', value: '#FFCC00' }]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a refusal that is a plain message (Tauri could not run the command) is said too', async () => {
    rust({ settings_set_mpv: () => Promise.reject('invalid args for command settings_set_mpv') });
    await open();
    fireEvent.click(screen.getByRole('switch', { name: 'Playlist from folder' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The setting could not be saved.');
    expect(console.warn).toHaveBeenCalled();
  });

  test('a refused setting of Kaleido\'s own is restored as well', async () => {
    rust({ settings_set: () => Promise.reject({ type: 'unavailable' }) });
    await open();

    fireEvent.click(picker('When a file is opened during playback'));
    fireEvent.click(screen.getByRole('option', { name: 'Add to the playlist' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The player is not running yet. Try again in a moment.',
    );
    expect(picker('When a file is opened during playback').textContent).toBe('Replace what is playing');
  });

  /** `settings_set_mpv` answers when the test says so: the calls wait here. */
  function slowWrites() {
    const calls: { args: unknown; resolve: () => void; reject: (reason: unknown) => void }[] = [];
    rust({
      settings_set_mpv: (args) =>
        new Promise((resolve, reject) => {
          calls.push({ args, resolve: () => { resolve(null); }, reject });
        }),
    });
    return calls;
  }

  test('a refusal of an older change that comes after a newer one was accepted changes nothing', async () => {
    const calls = slowWrites();
    await open();
    const remember = screen.getByRole('switch', { name: 'Remember position' });

    // A turns it off, B turns it on again; the two are on their way together.
    fireEvent.click(remember);
    fireEvent.click(remember);
    expect(mpvWrites()).toEqual([
      { key: 'save-position-on-quit', value: 'no' },
      { key: 'save-position-on-quit', value: 'yes' },
    ]);

    // Rust accepts B, and then says no to A, which it handled first.
    calls[1]?.resolve();
    await settle();
    calls[0]?.reject({ type: 'io', message: 'locked' });
    await settle();

    // B stays: no message for A, the switch is as B left it, the store has B's value.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(remember.getAttribute('aria-checked')).toBe('true');
    expect(useSettingsStore.getState().mpv['save-position-on-quit']).toBe('yes');
  });

  test('an older change that is answered late does not leave the store older than the newer one', async () => {
    const calls = slowWrites();
    await open();

    // A chooses "Off", B "Automatic with copy-back" before Rust has answered A.
    fireEvent.click(picker('Hardware decoding'));
    fireEvent.click(screen.getByRole('option', { name: 'Off (software)' }));
    fireEvent.click(picker('Hardware decoding'));
    fireEvent.click(screen.getByRole('option', { name: 'Automatic with copy-back (safe)' }));
    expect(mpvWrites()).toEqual([
      { key: 'hwdec', value: 'no' },
      { key: 'hwdec', value: 'auto-copy-safe' },
    ]);

    calls[1]?.resolve();
    await settle();
    expect(useSettingsStore.getState().mpv.hwdec).toBe('auto-copy-safe');

    // A is accepted too, but after B: the store keeps what Rust has last (B's).
    calls[0]?.resolve();
    await settle();

    expect(useSettingsStore.getState().mpv.hwdec).toBe('auto-copy-safe');
    expect(picker('Hardware decoding').textContent).toBe('Automatic with copy-back (safe)');
  });

  test('the message goes when the next change is made, and the new value stays', async () => {
    rust({ settings_set_mpv: () => Promise.reject({ type: 'io', message: 'locked' }) });
    await open();
    const remember = screen.getByRole('switch', { name: 'Remember position' });
    fireEvent.click(remember);
    await screen.findByRole('alert');

    rust();
    fireEvent.click(remember);
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => {
      expect(useSettingsStore.getState().mpv['save-position-on-quit']).toBe('no');
    });
    expect(remember.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('what applies at once, and what does not', () => {
  test('the default volume and the quality preset say they apply from the next start', async () => {
    await open();
    expect(description(picker('Hardware decoding'))).toEqual([]);

    fireEvent.click(sectionButton('Audio'));
    expect(description(screen.getByRole('slider', { name: 'Default volume' }))).toEqual([
      'Applies from the next start.',
    ]);
    // The maximum volume applies at once, and says nothing.
    expect(screen.getByRole('slider', { name: 'Maximum volume' }).hasAttribute('aria-describedby')).toBe(false);

    fireEvent.click(sectionButton('Video'));
    expect(description(picker('Quality preset'))).toEqual(['Applies from the next start.']);
    expect(picker('Deinterlacing').hasAttribute('aria-describedby')).toBe(false);
  });

  test('the shaders say where the files go and in what order they apply', async () => {
    await open();
    fireEvent.click(sectionButton('Video'));
    await screen.findByRole('checkbox', { name: 'Anime4K.glsl' });
    const [hint] = description(screen.getByRole('group', { name: 'Shaders' }));
    expect(hint).toContain('%APPDATA%\\Kaleido\\shaders');
    expect(hint).toContain('in the order you turn them on');
  });
});

describe('outside changes', () => {
  test('an outside settings:changed updates a field', async () => {
    await open();
    expect(picker('When a file is opened during playback').textContent).toBe('Replace what is playing');

    emit('settings:changed', { ...SETTINGS, playback: { openWhilePlaying: 'append' } });

    expect(picker('When a file is opened during playback').textContent).toBe('Add to the playlist');
    expect(useSettingsStore.getState().kaleido?.playback.openWhilePlaying).toBe('append');
  });

  test('a value being saved is not undone by an outside change that came before the answer', async () => {
    let answer: (value: unknown) => void = () => undefined;
    rust({
      settings_set: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    await open();

    fireEvent.click(picker('When a file is opened during playback'));
    fireEvent.click(screen.getByRole('option', { name: 'Add to the playlist' }));
    expect(picker('When a file is opened during playback').textContent).toBe('Add to the playlist');

    // Settings of other keys changed meanwhile; the save is still on its way.
    emit('settings:changed', { ...SETTINGS, language: 'cs' });
    expect(picker('When a file is opened during playback').textContent).toBe('Add to the playlist');

    answer({ ...SETTINGS, language: 'cs', playback: { openWhilePlaying: 'append' } });
    await waitFor(() => {
      expect(useSettingsStore.getState().kaleido?.playback.openWhilePlaying).toBe('append');
    });
    expect(picker('When a file is opened during playback').textContent).toBe('Add to the playlist');
  });
});

describe('the section list', () => {
  test('sections are reachable with the keyboard', async () => {
    await open();
    const detach = attachVideoInput(document.createElement('div'));
    try {
      const items = nav().getAllByRole('button') as HTMLButtonElement[];
      // One stop for Tab: the open section.
      expect(items.map((item) => item.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1]);

      act(() => {
        items[0]?.focus();
      });
      // The arrows move the focus through the list, and are handled (mpv does not get them).
      expect(fireEvent.keyDown(items[0] as Element, { key: 'ArrowDown', code: 'ArrowDown' })).toBe(false);
      expect(document.activeElement).toBe(items[1]);
      // Where the focus is, Tab reaches; moving is not opening.
      expect(items.map((item) => item.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1, -1]);
      expect(items[0]?.getAttribute('aria-current')).toBe('true');
      expect(sectionHeadings()).toEqual(['Playback']);

      expect(fireEvent.keyDown(items[1] as Element, { key: 'End', code: 'End' })).toBe(false);
      expect(document.activeElement).toBe(items[6]);
      // Round the end and back.
      fireEvent.keyDown(items[6] as Element, { key: 'ArrowDown', code: 'ArrowDown' });
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(items[0] as Element, { key: 'ArrowUp', code: 'ArrowUp' });
      expect(document.activeElement).toBe(items[6]);
      fireEvent.keyDown(items[6] as Element, { key: 'Home', code: 'Home' });
      expect(document.activeElement).toBe(items[0]);
      expect(forwarded()).toEqual([]);

      // Enter and Space on a button are the browser's click: they open the section, and the focus
      // goes to its heading.
      fireEvent.keyDown(items[2] as Element, { key: 'Enter', code: 'Enter' });
      expect(forwarded()).toEqual([]);
      act(() => {
        items[2]?.focus();
      });
      fireEvent.click(items[2] as Element);

      const heading = screen.getByRole('heading', { level: 2, name: 'Audio' });
      expect(sectionHeadings()).toEqual(['Audio']);
      expect(document.activeElement).toBe(heading);
      expect(items[2]?.getAttribute('aria-current')).toBe('true');
      expect(items[0]?.hasAttribute('aria-current')).toBe(false);
      // The section that is open is where Tab goes back to.
      expect(items.map((item) => item.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1, -1]);

      // A key the list does not handle still goes to mpv (so the checks above look at something).
      fireEvent.keyDown(items[2] as Element, { key: 'ArrowLeft', code: 'ArrowLeft' });
      expect(forwarded()).toHaveLength(1);
    } finally {
      detach();
    }
  });

  test('opening the open section again moves the focus to its heading', async () => {
    await open();
    const playback = sectionButton('Playback');
    fireEvent.click(playback);
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Playback' }));
  });
});

describe('the search', () => {
  test('typing shows the settings that match, under their sections', async () => {
    await open();
    expect(searchStatus()?.textContent).toBe('');

    fireEvent.change(searchField(), { target: { value: 'volume' } });
    expect(shownIds()).toEqual(['volume', 'volume-max']);
    expect(sectionHeadings()).toEqual(['Audio']);
    expect(searchStatus()?.textContent).toBe('Found: 2');

    // Settings of two sections, in the order of the sections.
    fireEvent.change(searchField(), { target: { value: 'language' } });
    expect(sectionHeadings()).toEqual(['Subtitles', 'Audio']);
    expect(shownIds()).toEqual(['slang', 'alang']);
    expect(searchStatus()?.textContent).toBe('Found: 2');
  });

  test('a match is found by its keywords, in any case', async () => {
    await open();
    fireEvent.change(searchField(), { target: { value: 'GPU' } });
    expect(shownIds()).toEqual(['hwdec', 'profile']);
  });

  test('says when nothing matches, and the fields of nothing are shown', async () => {
    await open();
    fireEvent.change(searchField(), { target: { value: 'zzz' } });
    expect(shownIds()).toEqual([]);
    expect(sectionHeadings()).toEqual([]);
    expect(searchStatus()?.textContent).toBe('No settings match “zzz”.');
  });

  test('a query of spaces is no search', async () => {
    await open();
    fireEvent.change(searchField(), { target: { value: '   ' } });
    expect(sectionHeadings()).toEqual(['Playback']);
    expect(searchStatus()?.textContent).toBe('');
  });

  test('a setting found by the search can be changed there', async () => {
    await open();
    fireEvent.change(searchField(), { target: { value: 'remember' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Remember position' }));
    expect(mpvWrites()).toEqual([{ key: 'save-position-on-quit', value: 'no' }]);
  });

  test('Esc clears the search and is handled; with nothing typed it is not the search\'s', async () => {
    await open();
    fireEvent.change(searchField(), { target: { value: 'font' } });
    expect(shownIds()).toEqual(['sub-font']);

    expect(fireEvent.keyDown(searchField(), { key: 'Escape', code: 'Escape' })).toBe(false);
    expect(searchField().value).toBe('');
    expect(sectionHeadings()).toEqual(['Playback']);

    expect(fireEvent.keyDown(searchField(), { key: 'Escape', code: 'Escape' })).toBe(true);
  });

  test('opening a section ends the search', async () => {
    await open();
    fireEvent.change(searchField(), { target: { value: 'font' } });

    fireEvent.click(sectionButton('Audio'));

    expect(searchField().value).toBe('');
    expect(sectionHeadings()).toEqual(['Audio']);
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Audio' }));
  });

  test('while the search shows its results no section is the current one', async () => {
    await open();
    expect(sectionButton('Playback').getAttribute('aria-current')).toBe('true');

    fireEvent.change(searchField(), { target: { value: 'volume' } });
    expect(nav().getAllByRole('button').some((item) => item.hasAttribute('aria-current'))).toBe(false);

    fireEvent.change(searchField(), { target: { value: '' } });
    expect(sectionButton('Playback').getAttribute('aria-current')).toBe('true');
  });

  test('the down arrow and Enter in the search field go into the results', async () => {
    await open();
    // Nothing to go into yet: the key is not the field's.
    expect(fireEvent.keyDown(searchField(), { key: 'ArrowDown', code: 'ArrowDown' })).toBe(true);

    fireEvent.change(searchField(), { target: { value: 'remember' } });
    expect(fireEvent.keyDown(searchField(), { key: 'ArrowDown', code: 'ArrowDown' })).toBe(false);
    const remember = screen.getByRole('switch', { name: 'Remember position' });
    expect(document.activeElement).toBe(remember);

    act(() => {
      searchField().focus();
    });
    expect(fireEvent.keyDown(searchField(), { key: 'Enter', code: 'Enter' })).toBe(false);
    expect(document.activeElement).toBe(remember);

    // Nothing found: nothing to go into.
    act(() => {
      searchField().focus();
    });
    fireEvent.change(searchField(), { target: { value: 'zzz' } });
    expect(fireEvent.keyDown(searchField(), { key: 'ArrowDown', code: 'ArrowDown' })).toBe(true);
    expect(document.activeElement).toBe(searchField());
  });

  test('a first result that is a list gets the focus on its button', async () => {
    await open();
    fireEvent.change(searchField(), { target: { value: 'hardware' } });
    fireEvent.keyDown(searchField(), { key: 'ArrowDown', code: 'ArrowDown' });
    expect(document.activeElement).toBe(picker('Hardware decoding'));
  });

  test('Esc in a result comes back to the search field, and does not go to mpv', async () => {
    await open();
    const remember = screen.getByRole('switch', { name: 'Remember position' });
    // Without a search there is nothing to come back to: Esc is not the page's.
    act(() => {
      remember.focus();
    });
    expect(fireEvent.keyDown(remember, { key: 'Escape', code: 'Escape' })).toBe(true);

    const detach = attachVideoInput(document.createElement('div'));
    try {
      fireEvent.change(searchField(), { target: { value: 'remember' } });
      act(() => {
        screen.getByRole('switch', { name: 'Remember position' }).focus();
      });

      expect(
        fireEvent.keyDown(screen.getByRole('switch', { name: 'Remember position' }), {
          key: 'Escape',
          code: 'Escape',
        }),
      ).toBe(false);

      expect(document.activeElement).toBe(searchField());
      // The search is still there; only the focus came back.
      expect(searchField().value).toBe('remember');
      expect(forwarded()).toEqual([]);
    } finally {
      detach();
    }
  });

  test('Esc closes an open list first, and only the next one goes back to the field', async () => {
    await open();
    fireEvent.change(searchField(), { target: { value: 'hardware' } });
    fireEvent.click(picker('Hardware decoding'));
    expect(screen.getByRole('listbox')).toBeTruthy();

    expect(fireEvent.keyDown(document.activeElement as Element, { key: 'Escape', code: 'Escape' })).toBe(false);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(picker('Hardware decoding'));

    fireEvent.keyDown(picker('Hardware decoding'), { key: 'Escape', code: 'Escape' });
    expect(document.activeElement).toBe(searchField());
  });

  test('a click on a label works its control', async () => {
    await open();
    const label = screen.getByText('Remember position');
    expect(label.tagName).toBe('LABEL');
    expect(label.getAttribute('for')).toBe(screen.getByRole('switch', { name: 'Remember position' }).id);

    fireEvent.click(label);
    expect(mpvWrites()).toEqual([{ key: 'save-position-on-quit', value: 'no' }]);

    // A list opens from its label too.
    fireEvent.click(screen.getByText('Hardware decoding'));
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  test('typing in the search field is not forwarded to mpv', async () => {
    await open();
    const detach = attachVideoInput(document.createElement('div'));
    try {
      fireEvent.keyDown(searchField(), { key: 'a', code: 'KeyA' });
      fireEvent.keyDown(searchField(), { key: 'ArrowLeft', code: 'ArrowLeft' });
      fireEvent.keyDown(searchField(), { key: ' ', code: 'Space' });
      expect(forwarded()).toEqual([]);

      // The same key on the page itself goes to mpv: the check above looks at something.
      fireEvent.keyDown(document.body, { key: 'a', code: 'KeyA' });
      expect(forwarded()).toHaveLength(1);
    } finally {
      detach();
    }
  });

  test('the fields that take text keep the keys too', async () => {
    await open();
    fireEvent.click(sectionButton('Subtitles'));
    const detach = attachVideoInput(document.createElement('div'));
    try {
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Subtitle color' }), { key: 'f', code: 'KeyF' });
      fireEvent.keyDown(screen.getByRole('slider', { name: 'Subtitle size' }), {
        key: 'ArrowRight',
        code: 'ArrowRight',
      });
      expect(forwarded()).toEqual([]);
    } finally {
      detach();
    }
  });

  test('search finds settings without diacritics in the page too', async () => {
    setLanguage('cs');
    render(<SettingsPage />);
    await waitFor(() => {
      const remember = screen.getByRole('switch', { name: 'Pamatovat pozici' }) as HTMLButtonElement;
      expect(remember.disabled).toBe(false);
    });
    const items = within(screen.getByRole('navigation', { name: 'Sekce nastavení' })).getAllByRole('button');
    expect(items.map((item) => item.textContent)).toEqual([
      'Přehrávání',
      'Titulky',
      'Zvuk',
      'Obraz',
      'Vzhled',
      'Zkratky',
      'O aplikaci',
    ]);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Hledat v nastavení' }), {
      target: { value: 'pismo' },
    });

    expect(shownIds()).toEqual(['sub-font']);
    expect(sectionHeadings()).toEqual(['Titulky']);
    expect(screen.getByText('Písmo titulků')).toBeTruthy();
    expect(searchStatus()?.textContent).toBe('Nalezeno: 1');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Hledat v nastavení' }), {
      target: { value: 'nesmysl' },
    });
    expect(searchStatus()?.textContent).toBe('Pro „nesmysl“ se v nastavení nic nenašlo.');
  });
});
