import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../../i18n';
import { useLanguage } from '../../i18n/useLanguage';
import type { Appearance as AppearanceSettings, Settings, SystemAppearance } from '../../ipc/types';
import { useUiStore } from '../../state/uiStore';
import { DEFAULT_APPEARANCE, defaultTokens, toCssVariables } from '../../theme/tokens';
import { useSettingsStore } from '../store';
import Appearance from './Appearance';

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
  updates: { ytdlpChannel: 'stable' },
};

const WINDOWS_11: SystemAppearance = { transparencyEffects: true, highContrast: false, windowsBuild: 22631 };
const WINDOWS_10: SystemAppearance = { transparencyEffects: true, highContrast: false, windowsBuild: 19045 };

type Answers = Record<string, (args: unknown) => unknown>;

/** What Rust has: the settings as they are now (a patch changes them, as `settings_set` does). */
let current: Settings;

/** RFC 7386 as Rust applies it: `null` takes a key out, so it is its default again. */
function applyPatch(settings: Settings, patch: Record<string, unknown>): Settings {
  const defaults = SETTINGS as unknown as Record<string, unknown>;
  const next = structuredClone(settings) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    const there = next[key];
    if (value === null) {
      next[key] = structuredClone(defaults[key]);
    } else if (typeof value === 'object' && typeof there === 'object' && there !== null) {
      const section = there as Record<string, unknown>;
      for (const [name, inner] of Object.entries(value)) {
        section[name] =
          inner === null ? (defaults[key] as Record<string, unknown>)[name] : (inner as unknown);
      }
    } else {
      next[key] = value;
    }
  }
  return next as unknown as Settings;
}

/** How Rust answers the commands; `answers` replaces some. */
function rust(answers: Answers = {}) {
  const all: Answers = {
    settings_get: () => current,
    settings_set: (args) => {
      current = applyPatch(current, (args as { patch: Record<string, unknown> }).patch);
      // Rust tells every listener of the new settings.
      events.handlers.get('settings:changed')?.({ payload: current });
      return current;
    },
    system_appearance: () => WINDOWS_11,
    system_locale: () => 'en-US',
    ...answers,
  };
  vi.mocked(invoke).mockImplementation(((command: string, args?: unknown) =>
    Promise.resolve(all[command]?.(args) ?? null)) as unknown as typeof invoke);
}

const sent = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

/** The patches `settings_set` was called with. */
const patches = () => sent('settings_set').map(([, args]) => (args as { patch: unknown }).patch);

/** The settings the page holds, as if Rust had given them. */
function seed(settings: Settings) {
  current = settings;
  useSettingsStore.setState({ status: 'ready', kaleido: settings, mpvLoaded: true });
}

/** The appearance with `changes` over the defaults. */
const appearance = (changes: Partial<AppearanceSettings>): AppearanceSettings => ({
  ...DEFAULT_APPEARANCE,
  ...changes,
});

const slider = (name: string) => screen.getByRole('slider', { name }) as HTMLInputElement;
const picker = (label: string) =>
  screen.getByRole('button', { name: new RegExp(`^${label}`) }) as HTMLButtonElement;
const preview = () => screen.getByRole('img', { name: 'Preview of the interface with these settings' });
/** One token of the preview, as the CSS variable the preview's element carries. */
const previewVariable = (name: string) => preview().style.getPropertyValue(name);
const shownIds = () =>
  Array.from(document.querySelectorAll('[data-setting]')).map((row) => row.getAttribute('data-setting'));

/** What a control's `aria-describedby` points at, as text. */
const description = (control: HTMLElement) =>
  (control.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent);

/** Lets the answers that are on their way arrive, and what they set in motion run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Renders the page and lets what it asks of Rust (Windows' appearance) arrive. */
async function mount(ui: ReactElement) {
  const view = render(ui);
  await settle();
  return view;
}

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  events.handlers.clear();
  vi.mocked(invoke).mockReset();
  current = SETTINGS;
  rust();
  // A change Rust refuses is logged, and some tests make it.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  setLanguage('en');
});

describe('the settings of the section', () => {
  test('are the language and the look, in the order of the brief, with the values Rust has', async () => {
    seed({
      ...SETTINGS,
      appearance: appearance({ blur: 12, glassOpacity: 0.6, saturation: 1.25, radius: 8, uiScale: 1.1 }),
    });
    await mount(<Appearance />);

    expect(shownIds()).toEqual([
      'language',
      'appearance.mode',
      'appearance.accent',
      'appearance.glassTint',
      'appearance.glassOpacity',
      'appearance.blur',
      'appearance.saturation',
      'appearance.radius',
      'appearance.mica',
      'appearance.reduceTransparency',
      'appearance.uiScale',
    ]);
    // The numbers are written as the setting is understood: percentages, and pixels.
    expect(slider('Glass opacity').getAttribute('aria-valuetext')).toBe('60%');
    expect(slider('Glass blur').getAttribute('aria-valuetext')).toBe('12 px');
    expect(slider('Glass saturation').getAttribute('aria-valuetext')).toBe('125%');
    expect(slider('Glass corner radius').getAttribute('aria-valuetext')).toBe('8 px');
    expect(slider('Interface scale').getAttribute('aria-valuetext')).toBe('110%');
    // The slider itself holds the setting's own number.
    expect(slider('Glass opacity').value).toBe('0.6');
    expect(slider('Glass blur').value).toBe('12');
    expect(picker('Language').textContent).toBe('Follow the system');
    expect(picker('Color mode').textContent).toBe('Follow Windows');
    expect(picker('Reduce transparency').textContent).toBe('Automatic (follow Windows)');
    expect((screen.getByRole('textbox', { name: 'Glass tint' }) as HTMLInputElement).value).toBe('#16161c');
  });

  test('the sliders reach the ends of the ranges Rust accepts', async () => {
    seed(SETTINGS);
    await mount(<Appearance />);
    const ranges = (name: string) => {
      const input = slider(name);
      return [input.min, input.max];
    };
    expect(ranges('Glass opacity')).toEqual(['0.3', '0.95']);
    expect(ranges('Glass blur')).toEqual(['0', '40']);
    expect(ranges('Glass saturation')).toEqual(['0.5', '2']);
    expect(ranges('Glass corner radius')).toEqual(['0', '28']);
    expect(ranges('Interface scale')).toEqual(['0.9', '1.5']);
  });

  test('wait for the settings: with none read there is no row, no preview and no reset', async () => {
    await mount(<Appearance />);
    expect(shownIds()).toEqual([]);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull();
  });

  test('a search shows the matching rows only, without the preview and the reset', async () => {
    seed(SETTINGS);
    await mount(<Appearance only={new Set(['appearance.blur'])} />);
    expect(shownIds()).toEqual(['appearance.blur']);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull();
  });
});

describe('the preview', () => {
  test('is a picture with its own tokens for the settings, and the root is left alone', async () => {
    seed({ ...SETTINGS, appearance: appearance({ mode: 'light', blur: 8, accent: '#ff8800' }) });
    await mount(<Appearance />);

    const light = toCssVariables(
      // The same tokens `useAppearance` gives the root, for the same settings.
      { ...defaultTokens('light'), glass: { ...defaultTokens('light').glass, blur: 8 } },
    );
    expect(preview().getAttribute('data-theme')).toBe('light');
    expect(previewVariable('--k-glass-blur')).toBe(light['--k-glass-blur']);
    expect(previewVariable('--k-glass-blur')).toBe('8px');
    expect(previewVariable('--k-accent-solid')).toBe('#ff8800');
    expect(previewVariable('--k-accent-gradient')).toBe('linear-gradient(90deg, #ff8800, #ff8800)');
    // The root belongs to useAppearance: nothing of the preview is written to it.
    expect(document.documentElement.style.getPropertyValue('--k-glass-blur')).toBe('');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  test('has islands over a gradient, named for a screen reader as one picture', async () => {
    seed(SETTINGS);
    await mount(<Appearance />);
    // Its parts are for the eye: the picture has the one label.
    expect(preview().getAttribute('role')).toBe('img');
    expect(preview().textContent).toContain('Sample video.mkv');
    expect(preview().querySelectorAll('[class*="glass"]').length).toBeGreaterThanOrEqual(3);
  });

  test('is opaque where transparency is reduced', async () => {
    seed({ ...SETTINGS, appearance: appearance({ reduceTransparency: 'on' }) });
    await mount(<Appearance />);
    expect(preview().getAttribute('data-reduce-transparency')).toBe('true');

    act(() => {
      useSettingsStore
        .getState()
        .setKaleido({ ...SETTINGS, appearance: appearance({ reduceTransparency: 'off' }) });
    });
    expect(preview().hasAttribute('data-reduce-transparency')).toBe(false);
  });

  test('"automatic" follows Windows: without transparency effects it is opaque', async () => {
    rust({ system_appearance: () => ({ ...WINDOWS_11, transparencyEffects: false }) });
    seed(SETTINGS);
    await mount(<Appearance />);
    await waitFor(() => {
      expect(preview().getAttribute('data-reduce-transparency')).toBe('true');
    });
  });

  test('is opaque where the glass failed, as the rest of the app is', async () => {
    seed(SETTINGS);
    useUiStore.getState().setGlass({ enabled: false, reason: 'gpuFailure' });
    await mount(<Appearance />);
    expect(preview().getAttribute('data-reduce-transparency')).toBe('true');
  });
});

describe('changes', () => {
  test('appearance changes apply live and persist', async () => {
    seed(SETTINGS);
    await mount(<Appearance />);
    expect(previewVariable('--k-glass-blur')).toBe('24px');

    // Dragged: the preview follows the thumb, and nothing is saved on the way.
    const blur = slider('Glass blur');
    fireEvent.pointerDown(blur);
    fireEvent.change(blur, { target: { value: '30' } });
    expect(previewVariable('--k-glass-blur')).toBe('30px');
    fireEvent.change(blur, { target: { value: '33' } });
    expect(previewVariable('--k-glass-blur')).toBe('33px');
    expect(patches()).toEqual([]);

    // Let go: the value where it is let go is saved, once, as a patch of that one setting.
    fireEvent.pointerUp(blur);
    expect(patches()).toEqual([{ appearance: { blur: 33 } }]);
    await waitFor(() => {
      expect(useSettingsStore.getState().kaleido?.appearance.blur).toBe(33);
    });
    // It stays: the preview now follows the saved value.
    expect(previewVariable('--k-glass-blur')).toBe('33px');
    expect(slider('Glass blur').getAttribute('aria-valuetext')).toBe('33 px');
    expect(current.appearance.blur).toBe(33);
    // The root is useAppearance's, which hears settings:changed; this page does not write to it.
    expect(document.documentElement.style.getPropertyValue('--k-glass-blur')).toBe('');

    // The mode: a list, and the preview is drawn in it once Rust has the new settings.
    fireEvent.click(picker('Color mode'));
    fireEvent.click(screen.getByRole('option', { name: 'Light' }));
    expect(patches().at(-1)).toEqual({ appearance: { mode: 'light' } });
    await waitFor(() => {
      expect(preview().getAttribute('data-theme')).toBe('light');
    });
    expect(picker('Color mode').textContent).toBe('Light');

    // A switch.
    fireEvent.click(screen.getByRole('switch', { name: 'Mica' }));
    expect(patches().at(-1)).toEqual({ appearance: { mica: false } });
    await waitFor(() => {
      expect(useSettingsStore.getState().kaleido?.appearance.mica).toBe(false);
    });

    // A list with three words.
    fireEvent.click(picker('Reduce transparency'));
    fireEvent.click(screen.getByRole('option', { name: 'On' }));
    expect(patches().at(-1)).toEqual({ appearance: { reduceTransparency: 'on' } });
    await waitFor(() => {
      expect(preview().getAttribute('data-reduce-transparency')).toBe('true');
    });

    // Each patch holds the one setting that changed.
    expect(patches()).toEqual([
      { appearance: { blur: 33 } },
      { appearance: { mode: 'light' } },
      { appearance: { mica: false } },
      { appearance: { reduceTransparency: 'on' } },
    ]);
    expect(sent('settings_set_mpv')).toEqual([]);
  });

  test('a slider stepped with the keyboard changes the preview at once, and the fraction is saved as a fraction', async () => {
    seed(SETTINGS);
    await mount(<Appearance />);
    const opacity = slider('Glass opacity');

    fireEvent.keyDown(opacity, { key: 'ArrowRight' });
    fireEvent.change(opacity, { target: { value: '0.6' } });
    expect(previewVariable('--k-glass-opacity')).toBe('0.6');
    expect(opacity.getAttribute('aria-valuetext')).toBe('60%');
    expect(patches()).toEqual([{ appearance: { glassOpacity: 0.6 } }]);
    fireEvent.keyUp(opacity, { key: 'ArrowRight' });
    await settle();
    expect(useSettingsStore.getState().kaleido?.appearance.glassOpacity).toBe(0.6);
  });

  test('the glass opacity is shown as set, though the glass is never thinner than the text can bear', async () => {
    seed({ ...SETTINGS, appearance: appearance({ glassOpacity: 0.3 }) });
    await mount(<Appearance />);
    // The slider says what was set (30 %); the tokens hold the opacity at 45 % at the least (spec 8.9).
    expect(slider('Glass opacity').getAttribute('aria-valuetext')).toBe('30%');
    expect(previewVariable('--k-glass-opacity')).toBe('0.45');
  });

  test('the accent is the rainbow or a colour, and the colour is checked before it is sent', async () => {
    seed(SETTINGS);
    await mount(<Appearance />);
    expect(screen.getByRole('radio', { name: 'Kaleido' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('textbox', { name: 'Accent color code' })).toBeNull();

    // "My color" starts from a violet, which is saved at once.
    fireEvent.click(screen.getByRole('radio', { name: 'My color' }));
    expect(patches()).toEqual([{ appearance: { accent: '#A98BFF' } }]);
    const code = (await screen.findByRole('textbox', { name: 'Accent color code' })) as HTMLInputElement;
    expect(code.value).toBe('#A98BFF');
    await waitFor(() => {
      expect(previewVariable('--k-accent-solid')).toBe('#a98bff');
    });

    // Not a colour: not sent, and the row says so.
    fireEvent.change(code, { target: { value: '#12345678' } });
    fireEvent.blur(code);
    expect(patches()).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toBe('Use #RRGGBB.');
    expect(code.getAttribute('aria-invalid')).toBe('true');

    // A colour, typed without its #.
    fireEvent.change(code, { target: { value: 'ff8800' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.blur(code);
    expect(patches().at(-1)).toEqual({ appearance: { accent: '#FF8800' } });
    await waitFor(() => {
      expect(previewVariable('--k-accent-solid')).toBe('#ff8800');
    });

    // Back to the rainbow, and to the colour the user had, when they come back to it.
    fireEvent.click(screen.getByRole('radio', { name: 'Kaleido' }));
    expect(patches().at(-1)).toEqual({ appearance: { accent: 'kaleido' } });
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: 'Accent color code' })).toBeNull();
    });
    fireEvent.click(screen.getByRole('radio', { name: 'My color' }));
    expect(patches().at(-1)).toEqual({ appearance: { accent: '#FF8800' } });
  });

  test('the glass tint is a colour with no alpha', async () => {
    seed(SETTINGS);
    await mount(<Appearance />);
    const tint = screen.getByRole('textbox', { name: 'Glass tint' }) as HTMLInputElement;
    expect(tint.placeholder).toBe('#RRGGBB');

    // #AARRGGBB is a colour for mpv's subtitles and none for the glass.
    fireEvent.change(tint, { target: { value: '#80102030' } });
    fireEvent.blur(tint);
    expect(patches()).toEqual([]);
    expect(screen.getByRole('alert').textContent).toBe('Use #RRGGBB.');

    fireEvent.change(tint, { target: { value: '102030' } });
    fireEvent.blur(tint);
    expect(patches()).toEqual([{ appearance: { glassTint: '#102030' } }]);
  });

  test('a value Rust refuses goes back, with the reason at the row, and the preview does not keep it', async () => {
    rust({
      settings_set: () => Promise.reject({ type: 'invalid', key: 'appearance.glassTint', reason: '#RRGGBB' }),
    });
    seed(SETTINGS);
    await mount(<Appearance />);
    const tint = screen.getByRole('textbox', { name: 'Glass tint' }) as HTMLInputElement;

    fireEvent.change(tint, { target: { value: '#102030' } });
    fireEvent.blur(tint);

    expect((await screen.findByRole('alert')).textContent).toBe('Use #RRGGBB.');
    expect(tint.value).toBe('#16161c');
    expect(previewVariable('--k-glass-tint')).toBe('#16161c');
  });

  test('a slider whose save is refused goes back, and so does the preview', async () => {
    rust({ settings_set: () => Promise.reject({ type: 'io', message: 'disk full' }) });
    seed(SETTINGS);
    await mount(<Appearance />);
    const radius = slider('Glass corner radius');

    fireEvent.pointerDown(radius);
    fireEvent.change(radius, { target: { value: '4' } });
    expect(previewVariable('--k-radius-l')).toBe('4px');
    fireEvent.pointerUp(radius);

    await screen.findByRole('alert');
    await waitFor(() => {
      expect(previewVariable('--k-radius-l')).toBe('20px');
    });
    expect(radius.getAttribute('aria-valuetext')).toBe('20 px');
  });
});

describe('reset', () => {
  const CHANGED = appearance({
    mode: 'dark',
    accent: '#ff8800',
    glassTint: '#102030',
    glassOpacity: 0.8,
    blur: 10,
    saturation: 1.8,
    radius: 4,
    mica: false,
    reduceTransparency: 'on',
    uiScale: 1.3,
  });

  test('reset restores the default appearance', async () => {
    seed({ ...SETTINGS, language: 'cs', appearance: CHANGED });
    await mount(<Appearance />);
    expect(slider('Glass blur').value).toBe('10');
    expect(previewVariable('--k-glass-blur')).toBe('10px');

    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));

    // The whole group at once: `null` takes `appearance` out, and Rust gives it its defaults.
    expect(sent('settings_set')).toEqual([['settings_set', { patch: { appearance: null } }]]);
    await waitFor(() => {
      expect(useSettingsStore.getState().kaleido?.appearance).toEqual(DEFAULT_APPEARANCE);
    });
    // Every field is back, and so is the preview.
    expect(slider('Glass blur').value).toBe('24');
    expect(slider('Glass opacity').value).toBe('0.55');
    expect(slider('Glass saturation').value).toBe('1.4');
    expect(slider('Glass corner radius').value).toBe('20');
    expect(slider('Interface scale').value).toBe('1');
    expect(picker('Color mode').textContent).toBe('Follow Windows');
    expect(picker('Reduce transparency').textContent).toBe('Automatic (follow Windows)');
    expect(screen.getByRole('radio', { name: 'Kaleido' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('textbox', { name: 'Glass tint' }) as HTMLInputElement).value).toBe('#16161c');
    expect(screen.getByRole('switch', { name: 'Mica' }).getAttribute('aria-checked')).toBe('true');
    expect(previewVariable('--k-glass-blur')).toBe('24px');
    expect(previewVariable('--k-accent-solid')).toBe('#a98bff');
    expect(previewVariable('--k-glass-tint')).toBe('#16161c');
    // The language is not part of the appearance.
    expect(current.language).toBe('cs');
    expect(useSettingsStore.getState().kaleido?.language).toBe('cs');
  });

  test('says when it could not, and can be tried again', async () => {
    rust({ settings_set: () => Promise.reject({ type: 'io', message: 'disk full' }) });
    seed({ ...SETTINGS, appearance: CHANGED });
    await mount(<Appearance />);
    const button = screen.getByRole('button', { name: 'Reset to default' }) as HTMLButtonElement;
    // Pressed from the keyboard: the button has the focus.
    act(() => {
      button.focus();
    });

    fireEvent.click(button);
    // It waits, and says so; a second press does nothing meanwhile. It is not disabled: the browser
    // takes the focus away from a disabled button (jsdom does not), and the keyboard user is lost.
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(sent('settings_set')).toHaveLength(1);

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The setting could not be saved. Check that the settings folder can be written to.',
    );
    expect(button.getAttribute('aria-disabled')).toBe('false');
    // The focus never left it (a disabled button would have dropped it to the page).
    expect(document.activeElement).toBe(button);
    expect(useSettingsStore.getState().kaleido?.appearance).toEqual(CHANGED);
    expect(slider('Glass blur').value).toBe('10');

    // The message goes with the next try, which works.
    rust();
    current = { ...SETTINGS, appearance: CHANGED };
    fireEvent.click(button);
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => {
      expect(useSettingsStore.getState().kaleido?.appearance).toEqual(DEFAULT_APPEARANCE);
    });
  });

  test('is one button that does not stay focused after the pointer, so that Space goes to mpv', async () => {
    seed({ ...SETTINGS, appearance: CHANGED });
    await mount(<Appearance />);
    const button = screen.getByRole('button', { name: 'Reset to default' });
    button.focus();
    fireEvent.pointerUp(button);
    expect(document.activeElement).not.toBe(button);
  });
});

describe('Mica', () => {
  test('mica is disabled on Windows 10 with an explanation', async () => {
    rust({ system_appearance: () => WINDOWS_10 });
    // Stored on: the page does not claim an effect the window does not have.
    seed({ ...SETTINGS, appearance: appearance({ mica: true }) });
    await mount(<Appearance />);

    const mica = screen.getByRole('switch', { name: 'Mica' }) as HTMLButtonElement;
    await waitFor(() => {
      expect(mica.disabled).toBe(true);
    });
    expect(mica.getAttribute('aria-checked')).toBe('false');
    // The explanation is the row's hint, and describes the switch.
    expect(description(mica)).toEqual([
      'Mica needs Windows 11. On Windows 10 the window has an opaque gradient background instead.',
    ]);

    // It cannot be turned on: the click does nothing, and nothing is sent.
    fireEvent.click(mica);
    expect(patches()).toEqual([]);
    // The stored choice is left as it was (it applies on Windows 11).
    expect(useSettingsStore.getState().kaleido?.appearance.mica).toBe(true);
    // The rest of the section is not affected.
    expect((slider('Glass blur') as HTMLInputElement).disabled).toBe(false);
  });

  test('is a switch on Windows 11, with a hint on what it is', async () => {
    rust({ system_appearance: () => WINDOWS_11 });
    seed(SETTINGS);
    await mount(<Appearance />);
    await settle();

    const mica = screen.getByRole('switch', { name: 'Mica' }) as HTMLButtonElement;
    expect(mica.disabled).toBe(false);
    expect(mica.getAttribute('aria-checked')).toBe('true');
    expect(description(mica)).toEqual(['Windows 11 only. The window background shows your wallpaper softly through it.']);

    fireEvent.click(mica);
    expect(patches()).toEqual([{ appearance: { mica: false } }]);
  });

  test('is left alone while the build is not known, and when Windows will not say', async () => {
    rust({ system_appearance: () => Promise.reject('no registry') });
    seed(SETTINGS);
    await mount(<Appearance />);
    await settle();

    const mica = screen.getByRole('switch', { name: 'Mica' }) as HTMLButtonElement;
    expect(mica.disabled).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  test('an answer that is no appearance is left out, as no answer', async () => {
    rust({ system_appearance: () => ({ windowsBuild: 'new' }) });
    seed(SETTINGS);
    await mount(<Appearance />);

    expect((screen.getByRole('switch', { name: 'Mica' }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('follows Windows when it changes', async () => {
    rust({ system_appearance: () => WINDOWS_11 });
    seed(SETTINGS);
    await mount(<Appearance />);
    await settle();
    expect((screen.getByRole('switch', { name: 'Mica' }) as HTMLButtonElement).disabled).toBe(false);

    act(() => {
      events.handlers.get('system:appearance-changed')?.({ payload: WINDOWS_10 });
    });
    expect((screen.getByRole('switch', { name: 'Mica' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the language', () => {
  /** What the app does with the language setting (App.tsx), beside the section. */
  function Switching() {
    useLanguage();
    return <Appearance />;
  }

  test('is saved as the setting\'s own word', async () => {
    seed(SETTINGS);
    await mount(<Appearance />);

    fireEvent.click(picker('Language'));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Follow the system',
      'Čeština',
      'English',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'Čeština' }));

    expect(patches()).toEqual([{ language: 'cs' }]);
    await waitFor(() => {
      expect(useSettingsStore.getState().kaleido?.language).toBe('cs');
    });
  });

  test('switches the texts at once, with no reload, and back', async () => {
    seed(SETTINGS);
    await mount(<Switching />);
    await settle();
    expect(picker('Language').textContent).toBe('Follow the system');

    fireEvent.click(picker('Language'));
    fireEvent.click(screen.getByRole('option', { name: 'Čeština' }));

    // The label of the row and the other rows are in Czech once Rust has told the new setting.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Jazyk/ }).textContent).toBe('Čeština');
    });
    expect(screen.getByRole('switch', { name: 'Mica' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Obnovit výchozí' })).toBeTruthy();
    expect(screen.getByLabelText('Rozmazání skla')).toBeTruthy();
    expect(document.documentElement.lang).toBe('cs');

    fireEvent.click(screen.getByRole('button', { name: /^Jazyk/ }));
    fireEvent.click(screen.getByRole('option', { name: 'English' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Language/ }).textContent).toBe('English');
    });
    expect(screen.getByRole('button', { name: 'Reset to default' })).toBeTruthy();
    expect(patches()).toEqual([{ language: 'cs' }, { language: 'en' }]);
  });

  test('"system" follows the language of Windows', async () => {
    rust({ system_locale: () => 'cs-CZ' });
    seed(SETTINGS);
    await mount(<Switching />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Obnovit výchozí' })).toBeTruthy();
    });
    expect(picker('Jazyk').textContent).toBe('Podle systému');
  });
});
