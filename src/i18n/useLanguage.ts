/**
 * Keeps the language of the UI up to date for as long as the component is mounted: the setting
 * (`settings_get`, then `settings:changed`) decides, and the system's language
 * (`system_locale`) decides where the setting is "system". Switching is live: the texts, the
 * formats and `<html lang>` change at once, with no reload.
 *
 * Until Rust has answered, the language is the one `main.tsx` started with: what the WebView
 * reports as the system's language (`navigator.language`, which follows Windows). That needs no
 * round trip, so the first paint is already in a language that is nearly always the right one;
 * this hook corrects it when the settings or the system's own answer say otherwise.
 */

import { useEffect, useLayoutEffect, useState } from 'react';

import { settingsGet, systemLocale } from '../ipc/commands';
import { onSettingsChanged } from '../ipc/events';
import { listenTo } from '../ipc/listen';
import type { Language } from '../ipc/types';
import { resolveLanguage, setLanguage } from './index';

export function useLanguage(): void {
  const [setting, setSetting] = useState<Language>('system');
  const [locale, setLocale] = useState(() => navigator.language);

  useEffect(() => {
    let mounted = true;
    // An event that comes while the first read is on its way is newer than that read.
    let heardSettings = false;
    const stop = listenTo(
      onSettingsChanged,
      (settings) => {
        heardSettings = true;
        setSetting(settings.language);
      },
      'settings:changed',
    );
    void settingsGet().then(
      (settings) => {
        if (mounted && !heardSettings) setSetting(settings.language);
      },
      (error: unknown) => {
        console.warn('settings_get failed; the language of the system stays', error);
      },
    );
    void systemLocale().then(
      (found) => {
        if (mounted) setLocale(found);
      },
      (error: unknown) => {
        console.warn('system_locale failed; the language of the WebView stays', error);
      },
    );
    return () => {
      mounted = false;
      stop();
    };
  }, []);

  const language = resolveLanguage(setting, locale);
  // Before the paint: the texts never show one language for a frame and then the other.
  useLayoutEffect(() => {
    setLanguage(language);
  }, [language]);
}
