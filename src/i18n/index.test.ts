import i18next from 'i18next';
import { afterEach, describe, expect, test } from 'vitest';

import { FALLBACK_LANGUAGE, initI18n, resolveLanguage, setLanguage } from './index';
import cs from './locales/cs.json';
import en from './locales/en.json';

describe('resolveLanguage', () => {
  test('follows the system unless set', () => {
    expect(resolveLanguage('system', 'cs-CZ')).toBe('cs');
    expect(resolveLanguage('system', 'sk-SK')).toBe('en');
    expect(resolveLanguage('en', 'cs-CZ')).toBe('en');
  });

  test('a language that is set wins over the system, whichever it is', () => {
    expect(resolveLanguage('cs', 'en-US')).toBe('cs');
    expect(resolveLanguage('cs', 'sk-SK')).toBe('cs');
    expect(resolveLanguage('cs', '')).toBe('cs');
    expect(resolveLanguage('en', 'cs')).toBe('en');
  });

  test.each(['cs', 'cs-CZ', 'cs_CZ', 'CS-cz', ' cs-CZ '])('"system" with %j is Czech', (locale) => {
    expect(resolveLanguage('system', locale)).toBe('cs');
  });

  test.each(['', 'en', 'en-US', 'en-GB', 'sk', 'sk-SK', 'de-DE', 'pl-PL', 'csb-PL', 'sl-SI', 'garbage', 'c'])(
    '"system" with %j is English',
    (locale) => {
      expect(resolveLanguage('system', locale)).toBe('en');
    },
  );
});

describe('the i18next instance', () => {
  // The tests run in this order on one instance, as the app has one: it starts uninitialised.
  afterEach(() => {
    document.documentElement.removeAttribute('lang');
  });

  test('is ready at once after initI18n, in the language it is given', () => {
    expect(i18next.isInitialized).toBe(false);

    initI18n('cs');

    expect(i18next.isInitialized).toBe(true);
    expect(i18next.language).toBe('cs');
    expect(i18next.t('home.openFile')).toBe(cs.home.openFile);
    expect(i18next.t('errors.generic')).toBe(cs.errors.generic);
    expect(document.documentElement.lang).toBe('cs');
  });

  test('a second initI18n only switches the language', () => {
    initI18n('en');

    expect(i18next.language).toBe('en');
    expect(i18next.t('home.openFile')).toBe(en.home.openFile);
    expect(document.documentElement.lang).toBe('en');
    // Both languages are still there.
    expect(i18next.t('home.openFile', { lng: 'cs' })).toBe(cs.home.openFile);
  });

  test('setLanguage switches the texts and <html lang>, and nothing else', () => {
    setLanguage('cs');
    expect(i18next.language).toBe('cs');
    expect(i18next.t('player.pause')).toBe(cs.player.pause);
    expect(document.documentElement.lang).toBe('cs');

    setLanguage('en');
    expect(i18next.language).toBe('en');
    expect(i18next.t('player.pause')).toBe(en.player.pause);
    expect(document.documentElement.lang).toBe('en');
  });

  test('setLanguage to the language that is on keeps <html lang> right', () => {
    setLanguage('en');
    document.documentElement.lang = '';
    setLanguage('en');
    expect(document.documentElement.lang).toBe('en');
  });

  test('falls back to English', () => {
    expect(FALLBACK_LANGUAGE).toBe('en');
    expect(i18next.options.fallbackLng).toEqual(['en']);
    // A language Kaleido has no texts in is shown in English.
    expect(i18next.t('home.openFile', { lng: 'sk' })).toBe(en.home.openFile);
  });

  test('does not escape what it is given: React does that', () => {
    // A default value is interpolated like a text; no key of the files needs to be touched.
    expect(i18next.t('no.such.key', { defaultValue: '{{value}}', value: 'a & <b>' })).toBe('a & <b>');
  });
});
