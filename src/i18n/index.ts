/**
 * Czech and English (spec 8.8). Every text of the UI is a key in `locales/cs.json` and
 * `locales/en.json`, grouped by where it is shown (`shell`, `home`, `player`, `panels`,
 * `settings`, `errors`); a task that adds a text adds the key to both files. Both files are
 * bundled, so there is nothing to load: `initI18n` is synchronous and the first paint already has
 * its texts. Components read them with `useTranslation` (react-i18next); dates and numbers go
 * through `format.ts`.
 */

import i18next, { type i18n } from 'i18next';
import { initReactI18next } from 'react-i18next';

import type { Language } from '../ipc/types';
import cs from './locales/cs.json';
import en from './locales/en.json';

/** The languages Kaleido has texts in. */
export const LANGUAGES = ['cs', 'en'] as const;

/** A language the UI is shown in: the setting `Language` once "system" has been looked up. */
export type ResolvedLanguage = (typeof LANGUAGES)[number];

/** A text that the current language lacks is shown in this one. */
export const FALLBACK_LANGUAGE: ResolvedLanguage = 'en';

/** Whether `locale`, a BCP 47 tag (`cs-CZ`; `cs_CZ` too), is Czech: its language subtag is `cs`. */
function isCzech(locale: string): boolean {
  const [language] = locale.trim().toLowerCase().split(/[-_]/);
  return language === 'cs';
}

/**
 * The language to show. What the user chose wins; "system" follows the system's language:
 * Czech becomes Czech, anything else English (spec 8.8).
 */
export function resolveLanguage(setting: Language, systemLocale: string): ResolvedLanguage {
  if (setting === 'cs' || setting === 'en') return setting;
  return isCzech(systemLocale) ? 'cs' : 'en';
}

/** `<html lang>` follows the language of the texts: screen readers pick their voice by it. */
function syncDocumentLanguage(language: ResolvedLanguage): void {
  document.documentElement.lang = language;
}

/**
 * Starts i18next with both languages, shown in `language`. Call it once, before the first render.
 * A second call only switches the language (as `setLanguage` does), so that tests and hot reloads
 * do not initialise twice.
 */
export function initI18n(language: ResolvedLanguage): i18n {
  if (i18next.isInitialized) {
    setLanguage(language);
    return i18next;
  }
  void i18next.use(initReactI18next).init({
    resources: { cs: { translation: cs }, en: { translation: en } },
    lng: language,
    fallbackLng: FALLBACK_LANGUAGE,
    supportedLngs: LANGUAGES,
    // The resources are in memory: initialising is synchronous, and nothing needs to suspend.
    initAsync: false,
    react: { useSuspense: false },
    // React escapes what it renders.
    interpolation: { escapeValue: false },
  });
  syncDocumentLanguage(language);
  return i18next;
}

/**
 * Switches the language of the texts, of `format.ts` and of `<html lang>`. The components that use
 * `useTranslation` draw again on their own.
 */
export function setLanguage(language: ResolvedLanguage): void {
  if (!i18next.isInitialized) {
    initI18n(language);
    return;
  }
  if (i18next.language !== language) void i18next.changeLanguage(language);
  syncDocumentLanguage(language);
}
