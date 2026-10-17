import { act, renderHook, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { StrictMode } from 'react';
import { useTranslation } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';

import { settingsGet, systemLocale } from '../ipc/commands';
import { onSettingsChanged } from '../ipc/events';
import type { Language, Settings } from '../ipc/types';
import { DEFAULT_APPEARANCE } from '../theme/tokens';
import { initI18n } from './index';
import cs from './locales/cs.json';
import en from './locales/en.json';
import { useLanguage } from './useLanguage';

vi.mock('../ipc/commands', () => ({ settingsGet: vi.fn(), systemLocale: vi.fn() }));
vi.mock('../ipc/events', () => ({ onSettingsChanged: vi.fn() }));

const html = document.documentElement;

const settings = (language: Language): Settings => ({
  version: 1,
  language,
  appearance: DEFAULT_APPEARANCE,
  playback: { openWhilePlaying: 'replace' },
});

describe('useLanguage', () => {
  let settingsListeners: ((payload: Settings) => void)[];
  let unlisten: Mock<() => void>;

  /** What the WebView reports as the language of the system (jsdom says en-US). */
  function webViewSays(locale: string): void {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue(locale);
  }

  /** The settings event Rust sends after `settings_set`. */
  function settingsChange(language: Language): void {
    act(() => {
      settingsListeners.at(-1)?.(settings(language));
    });
  }

  beforeEach(() => {
    settingsListeners = [];
    unlisten = vi.fn<() => void>();
    vi.mocked(onSettingsChanged).mockImplementation((callback) => {
      settingsListeners.push(callback);
      return Promise.resolve(unlisten);
    });
    vi.mocked(settingsGet).mockResolvedValue(settings('system'));
    vi.mocked(systemLocale).mockResolvedValue('en-US');
    // As main.tsx starts it: English, until something says otherwise.
    initI18n('en');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    html.removeAttribute('lang');
  });

  const mount = () => renderHook(() => { useLanguage(); }, { wrapper: StrictMode });
  const language = () => i18next.language;

  test('starts in the language the WebView reports, before Rust has answered', () => {
    webViewSays('cs-CZ');
    vi.mocked(settingsGet).mockReturnValue(new Promise<Settings>(() => undefined));
    vi.mocked(systemLocale).mockReturnValue(new Promise<string>(() => undefined));

    mount();

    expect(language()).toBe('cs');
    expect(html.lang).toBe('cs');
    expect(i18next.t('home.openFile')).toBe(cs.home.openFile);
  });

  test('"system" follows the language of the system: Czech is Czech', async () => {
    vi.mocked(systemLocale).mockResolvedValue('cs-CZ');
    mount();

    await waitFor(() => {
      expect(language()).toBe('cs');
    });
    expect(html.lang).toBe('cs');
    expect(settingsGet).toHaveBeenCalled();
    expect(systemLocale).toHaveBeenCalled();
  });

  test('"system" with any other language is English, whatever the WebView said first', async () => {
    webViewSays('cs-CZ');
    vi.mocked(systemLocale).mockResolvedValue('sk-SK');
    mount();
    expect(language()).toBe('cs');

    await waitFor(() => {
      expect(language()).toBe('en');
    });
    expect(html.lang).toBe('en');
  });

  test('English that is set wins over a Czech system', async () => {
    webViewSays('cs-CZ');
    vi.mocked(settingsGet).mockResolvedValue(settings('en'));
    vi.mocked(systemLocale).mockResolvedValue('cs-CZ');
    mount();
    expect(language()).toBe('cs');

    await waitFor(() => {
      expect(language()).toBe('en');
    });
    expect(i18next.t('home.openFile')).toBe(en.home.openFile);
    expect(html.lang).toBe('en');
  });

  test('Czech that is set wins over an English system', async () => {
    vi.mocked(settingsGet).mockResolvedValue(settings('cs'));
    vi.mocked(systemLocale).mockResolvedValue('en-US');
    mount();
    expect(language()).toBe('en');

    await waitFor(() => {
      expect(language()).toBe('cs');
    });
    expect(i18next.t('home.openFile')).toBe(cs.home.openFile);
    expect(html.lang).toBe('cs');
  });

  test('switches at runtime when the language setting changes', async () => {
    vi.mocked(systemLocale).mockResolvedValue('cs-CZ');
    mount();
    await waitFor(() => {
      expect(language()).toBe('cs');
    });
    expect(settingsListeners.length).toBeGreaterThan(0);

    settingsChange('en');
    expect(language()).toBe('en');
    expect(html.lang).toBe('en');
    expect(i18next.t('player.play')).toBe(en.player.play);

    settingsChange('cs');
    expect(language()).toBe('cs');
    expect(html.lang).toBe('cs');
    expect(i18next.t('player.play')).toBe(cs.player.play);

    // Back to "system": the language of the system is the one that was read at the start.
    settingsChange('en');
    settingsChange('system');
    expect(language()).toBe('cs');
    expect(html.lang).toBe('cs');
  });

  test('a component that uses useTranslation draws its texts again', async () => {
    vi.mocked(systemLocale).mockResolvedValue('sk-SK');
    const view = renderHook(
      () => {
        useLanguage();
        return useTranslation().t('home.openFile');
      },
      { wrapper: StrictMode },
    );
    await waitFor(() => {
      expect(settingsGet).toHaveBeenCalled();
      expect(systemLocale).toHaveBeenCalled();
    });
    expect(view.result.current).toBe(en.home.openFile);

    settingsChange('cs');
    expect(view.result.current).toBe(cs.home.openFile);

    settingsChange('en');
    expect(view.result.current).toBe(en.home.openFile);
  });

  test('an event that comes while the first read is on its way is the newer one', async () => {
    let answer: (value: Settings) => void = () => undefined;
    vi.mocked(settingsGet).mockReturnValue(
      new Promise<Settings>((resolve) => {
        answer = resolve;
      }),
    );
    mount();
    settingsChange('cs');
    expect(language()).toBe('cs');

    // The older answer arrives late and is not shown.
    await act(async () => {
      answer(settings('en'));
      await Promise.resolve();
    });
    expect(language()).toBe('cs');
  });

  test('stops listening when it unmounts, also in StrictMode, which mounts twice', async () => {
    const view = mount();
    await waitFor(() => {
      expect(systemLocale).toHaveBeenCalled();
    });
    // Two mounts, two subscriptions; the first is let go as soon as it exists.
    expect(onSettingsChanged).toHaveBeenCalledTimes(2);

    view.unmount();
    await waitFor(() => {
      expect(unlisten).toHaveBeenCalledTimes(2);
    });

    // A late event changes nothing.
    settingsChange('cs');
    expect(language()).toBe('en');
  });

  test('keeps the language of the WebView, and says so, when Rust cannot answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    webViewSays('cs-CZ');
    vi.mocked(settingsGet).mockRejectedValue('no settings');
    vi.mocked(systemLocale).mockRejectedValue('no locale');
    mount();

    await waitFor(() => {
      expect(warn.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    const said = warn.mock.calls.map(([message]) => String(message)).join(' ');
    expect(said).toContain('settings_get');
    expect(said).toContain('system_locale');
    expect(language()).toBe('cs');
  });
});
