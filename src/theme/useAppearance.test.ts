import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';

import { settingsGet, systemAppearance } from '../ipc/commands';
import { onSettingsChanged, onSystemAppearanceChanged } from '../ipc/events';
import type { Appearance, Settings, SystemAppearance } from '../ipc/types';
import { useUiStore } from '../state/uiStore';
import { DEFAULT_APPEARANCE, defaultTokens } from './tokens';
import { applyRoot, resolveRoot, useAppearance } from './useAppearance';

vi.mock('../ipc/commands', () => ({ settingsGet: vi.fn(), systemAppearance: vi.fn() }));
vi.mock('../ipc/events', () => ({
  onSettingsChanged: vi.fn(),
  onSystemAppearanceChanged: vi.fn(),
}));

const root = document.documentElement;

const settings = (changes: Partial<Appearance>): Settings => ({
  version: 1,
  language: 'system',
  appearance: { ...DEFAULT_APPEARANCE, ...changes },
  playback: { openWhilePlaying: 'replace' },
  updates: { ytdlpChannel: 'stable' },
});

const windows = (changes: Partial<SystemAppearance> = {}): SystemAppearance => ({
  transparencyEffects: true,
  highContrast: false,
  windowsBuild: 22631,
  ...changes,
});

describe('resolveRoot', () => {
  test('follows the settings and Windows', () => {
    const normal = resolveRoot(DEFAULT_APPEARANCE, windows(), true);
    expect(normal).toMatchObject({ theme: 'dark', reduceTransparency: false, mica: true, scale: 1 });
    expect(normal.tokens).toEqual(defaultTokens('dark'));

    // The mode "system" follows the colour scheme; the others do not.
    expect(resolveRoot(DEFAULT_APPEARANCE, windows(), false).theme).toBe('light');
    expect(resolveRoot({ ...DEFAULT_APPEARANCE, mode: 'dark' }, windows(), false).theme).toBe('dark');
    expect(resolveRoot({ ...DEFAULT_APPEARANCE, mode: 'light' }, windows(), true).theme).toBe('light');
  });

  test('the default glass tint is white in the light mode and a chosen one stays (R35)', () => {
    // The mode "system" with a light Windows, and the mode "light" with a dark one: the real path.
    expect(resolveRoot(DEFAULT_APPEARANCE, windows(), false).tokens.glass.tint).toBe('#ffffff');
    expect(resolveRoot({ ...DEFAULT_APPEARANCE, mode: 'light' }, windows(), true).tokens.glass.tint).toBe(
      '#ffffff',
    );
    // Dark: the default stays the dark one.
    expect(resolveRoot(DEFAULT_APPEARANCE, windows(), true).tokens.glass.tint).toBe(
      DEFAULT_APPEARANCE.glassTint,
    );
    // A tint the user chose is theirs in both modes.
    for (const prefersDark of [true, false]) {
      const chosen = resolveRoot({ ...DEFAULT_APPEARANCE, glassTint: '#102030' }, windows(), prefersDark);
      expect(chosen.tokens.glass.tint, `prefersDark ${prefersDark}`).toBe('#102030');
    }
  });

  test('reduces transparency for Windows, for high contrast and for the user, and Mica with it', () => {
    const off = windows({ transparencyEffects: false });
    expect(resolveRoot(DEFAULT_APPEARANCE, off, true)).toMatchObject({ reduceTransparency: true, mica: false });
    expect(resolveRoot(DEFAULT_APPEARANCE, windows({ highContrast: true }), true)).toMatchObject({
      reduceTransparency: true,
      mica: false,
    });
    expect(resolveRoot({ ...DEFAULT_APPEARANCE, reduceTransparency: 'on' }, windows(), true)).toMatchObject({
      reduceTransparency: true,
      mica: false,
    });
    // "off" keeps the glass although Windows has no effects.
    expect(resolveRoot({ ...DEFAULT_APPEARANCE, reduceTransparency: 'off' }, off, true).reduceTransparency).toBe(
      false,
    );
  });

  test('Mica only on Windows 11 with the switch on', () => {
    expect(resolveRoot(DEFAULT_APPEARANCE, windows({ windowsBuild: 19045 }), true).mica).toBe(false);
    expect(resolveRoot({ ...DEFAULT_APPEARANCE, mica: false }, windows(), true).mica).toBe(false);
  });

  test('a glass that Rust switched off is opaque, and Mica stays', () => {
    const failed = resolveRoot(DEFAULT_APPEARANCE, windows(), true, false);
    expect(failed.reduceTransparency).toBe(true);
    expect(failed.mica).toBe(true);
  });

  test('the scale is held to 90–150 %', () => {
    expect(resolveRoot({ ...DEFAULT_APPEARANCE, uiScale: 3 }, windows(), true).scale).toBe(1.5);
    expect(resolveRoot({ ...DEFAULT_APPEARANCE, uiScale: 0.2 }, windows(), true).scale).toBe(0.9);
  });
});

describe('applyRoot', () => {
  test('writes the tokens, the attributes and the scale, and takes the flags away again', () => {
    const element = document.createElement('div');
    applyRoot(element, resolveRoot({ ...DEFAULT_APPEARANCE, uiScale: 1.25 }, windows({ transparencyEffects: false }), false));
    expect(element.dataset.theme).toBe('light');
    expect(element.hasAttribute('data-reduce-transparency')).toBe(true);
    expect(element.hasAttribute('data-mica')).toBe(false);
    expect(element.style.getPropertyValue('--k-ui-scale')).toBe('1.25');
    expect(element.style.getPropertyValue('--k-font-size-m')).toBe('13px');

    applyRoot(element, resolveRoot(DEFAULT_APPEARANCE, windows(), true));
    expect(element.dataset.theme).toBe('dark');
    expect(element.hasAttribute('data-reduce-transparency')).toBe(false);
    expect(element.hasAttribute('data-mica')).toBe(true);
    expect(element.style.getPropertyValue('--k-ui-scale')).toBe('1');
  });
});

describe('useAppearance', () => {
  let settingsListeners: ((payload: Settings) => void)[];
  let systemListeners: ((payload: SystemAppearance) => void)[];
  let unlisten: Mock<() => void>;

  /** Windows' colour scheme as the WebView reports it; `flip` changes it and tells the hook. */
  function stubColorScheme(dark: boolean) {
    let matches = dark;
    const handlers = new Set<() => void>();
    const query = {
      get matches() {
        return matches;
      },
      addEventListener: (_type: string, handler: () => void) => handlers.add(handler),
      removeEventListener: (_type: string, handler: () => void) => handlers.delete(handler),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => query));
    return (next: boolean) => {
      matches = next;
      for (const handler of handlers) handler();
    };
  }

  beforeEach(() => {
    settingsListeners = [];
    systemListeners = [];
    unlisten = vi.fn<() => void>();
    vi.mocked(onSettingsChanged).mockImplementation((callback) => {
      settingsListeners.push(callback);
      return Promise.resolve(unlisten);
    });
    vi.mocked(onSystemAppearanceChanged).mockImplementation((callback) => {
      systemListeners.push(callback);
      return Promise.resolve(unlisten);
    });
    vi.mocked(settingsGet).mockResolvedValue(settings({}));
    vi.mocked(systemAppearance).mockResolvedValue(windows());
    useUiStore.setState(useUiStore.getInitialState(), true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    for (const { name } of [...root.attributes]) {
      if (name.startsWith('data-') || name === 'style') root.removeAttribute(name);
    }
  });

  const mount = () => renderHook(() => { useAppearance(); }, { wrapper: StrictMode });

  test('puts the settings and Windows on the root element', async () => {
    vi.mocked(settingsGet).mockResolvedValue(settings({ mode: 'light', uiScale: 1.25, accent: '#ff8800' }));
    mount();

    await waitFor(() => {
      expect(root.dataset.theme).toBe('light');
      // Windows 11, the switch on, transparency not reduced.
      expect(root.hasAttribute('data-mica')).toBe(true);
    });
    expect(root.hasAttribute('data-reduce-transparency')).toBe(false);
    expect(root.style.getPropertyValue('--k-ui-scale')).toBe('1.25');
    expect(root.style.getPropertyValue('--k-accent-solid')).toBe('#ff8800');
    expect(root.style.getPropertyValue('--k-font-size-m')).toBe('13px');
    expect(settingsGet).toHaveBeenCalled();
    expect(systemAppearance).toHaveBeenCalled();
  });

  test('has the tokens on the root before anything has been read', () => {
    vi.mocked(settingsGet).mockReturnValue(new Promise<Settings>(() => undefined));
    vi.mocked(systemAppearance).mockReturnValue(new Promise<SystemAppearance>(() => undefined));
    mount();
    // The default settings, until the real ones arrive: no unstyled page.
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.getPropertyValue('--k-font-size-m')).toBe('13px');
    expect(root.style.getPropertyValue('--k-ui-scale')).toBe('1');
    // Windows' build is not known, so no Mica yet.
    expect(root.hasAttribute('data-mica')).toBe(false);
  });

  test('follows the events of the settings and of Windows', async () => {
    mount();
    await waitFor(() => {
      expect(root.hasAttribute('data-mica')).toBe(true);
    });
    expect(settingsListeners.length).toBeGreaterThan(0);
    expect(systemListeners.length).toBeGreaterThan(0);

    // Windows switches its transparency effects off: "auto" reduces, and there is no Mica.
    act(() => {
      systemListeners.at(-1)?.(windows({ transparencyEffects: false }));
    });
    expect(root.hasAttribute('data-reduce-transparency')).toBe(true);
    expect(root.hasAttribute('data-mica')).toBe(false);

    // The user keeps the glass: their word wins, and Mica is back.
    act(() => {
      settingsListeners.at(-1)?.(settings({ reduceTransparency: 'off', mode: 'light' }));
    });
    expect(root.hasAttribute('data-reduce-transparency')).toBe(false);
    expect(root.hasAttribute('data-mica')).toBe(true);
    expect(root.dataset.theme).toBe('light');
  });

  test('the glass that Rust switched off is drawn opaque', async () => {
    mount();
    await waitFor(() => {
      expect(root.hasAttribute('data-mica')).toBe(true);
    });
    expect(root.hasAttribute('data-reduce-transparency')).toBe(false);

    act(() => {
      useUiStore.getState().setGlass({ enabled: false, reason: 'gpuFailure' });
    });
    expect(root.hasAttribute('data-reduce-transparency')).toBe(true);
    expect(root.hasAttribute('data-mica')).toBe(true);

    act(() => {
      useUiStore.getState().setGlass({ enabled: true, reason: null });
    });
    expect(root.hasAttribute('data-reduce-transparency')).toBe(false);
  });

  test('the mode "system" follows the colour scheme of Windows as it changes', async () => {
    const flip = stubColorScheme(true);
    mount();
    await waitFor(() => {
      expect(root.dataset.theme).toBe('dark');
      expect(root.hasAttribute('data-mica')).toBe(true);
    });

    act(() => {
      flip(false);
    });
    expect(root.dataset.theme).toBe('light');
    act(() => {
      flip(true);
    });
    expect(root.dataset.theme).toBe('dark');
  });

  test('an event that comes while the first read is on its way is the newer one', async () => {
    let answer: (value: Settings) => void = () => undefined;
    vi.mocked(settingsGet).mockReturnValue(
      new Promise<Settings>((resolve) => {
        answer = resolve;
      }),
    );
    mount();
    act(() => {
      settingsListeners.at(-1)?.(settings({ mode: 'light' }));
    });
    expect(root.dataset.theme).toBe('light');

    // The older answer arrives late and is not shown.
    await act(async () => {
      answer(settings({ mode: 'dark' }));
      await Promise.resolve();
    });
    expect(root.dataset.theme).toBe('light');
  });

  test('stops listening when it unmounts, also in StrictMode, which mounts twice', async () => {
    const view = mount();
    await waitFor(() => {
      expect(root.hasAttribute('data-mica')).toBe(true);
    });
    // Two mounts, two subscriptions each; the first pair is let go as soon as it exists.
    expect(onSettingsChanged).toHaveBeenCalledTimes(2);
    expect(onSystemAppearanceChanged).toHaveBeenCalledTimes(2);

    view.unmount();
    await waitFor(() => {
      expect(unlisten).toHaveBeenCalledTimes(4);
    });

    // A late event changes nothing.
    act(() => {
      settingsListeners.at(-1)?.(settings({ mode: 'light' }));
      systemListeners.at(-1)?.(windows({ transparencyEffects: false }));
    });
    expect(root.dataset.theme).toBe('dark');
    expect(root.hasAttribute('data-reduce-transparency')).toBe(false);
  });

  test('keeps the defaults, and says so, when Rust cannot answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(settingsGet).mockRejectedValue('no settings');
    vi.mocked(systemAppearance).mockRejectedValue('no appearance');
    mount();

    await waitFor(() => {
      expect(warn.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    const said = warn.mock.calls.map(([message]) => String(message)).join(' ');
    expect(said).toContain('settings_get');
    expect(said).toContain('system_appearance');
    expect(root.dataset.theme).toBe('dark');
    warn.mockRestore();
  });
});
