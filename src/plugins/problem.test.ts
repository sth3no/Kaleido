import i18next from 'i18next';
import { beforeAll, describe, expect, test } from 'vitest';

import { initI18n, setLanguage } from '../i18n';
import { listOf, localized } from './localized';
import { problemOf, problemText } from './problem';

beforeAll(() => {
  initI18n('en');
});

describe('problemOf', () => {
  test('reads what Rust rejects a plugin command with', () => {
    expect(problemOf({ type: 'busy' })).toEqual({ code: 'busy', message: '' });
    expect(problemOf({ type: 'unavailable' })).toEqual({ code: 'unavailable', message: '' });
    expect(problemOf({ type: 'notFound', name: 'uosc' })).toEqual({ code: 'notFound', message: 'uosc' });
    expect(problemOf({ type: 'io', message: 'access denied' })).toEqual({
      code: 'io',
      message: 'access denied',
    });
    // A setting's refusal is not one of this page's; it is a generic failure with Rust's reason.
    expect(problemOf({ type: 'invalid', key: 'k', reason: 'out of range' })).toEqual({
      code: 'generic',
      message: 'out of range',
    });
  });

  test('anything else is a generic failure of the call', () => {
    expect(problemOf(new Error('boom'))).toEqual({ code: 'generic', message: 'boom' });
    expect(problemOf('a message')).toEqual({ code: 'generic', message: 'a message' });
    expect(problemOf(null)).toEqual({ code: 'generic', message: 'null' });
    expect(problemOf({ type: 'new thing' })).toEqual({ code: 'generic', message: '[object Object]' });
  });
});

describe('problemText', () => {
  const { t } = i18next;

  test('says each in words, and an Io problem as Rust’s own message', () => {
    expect(problemText({ code: 'busy', message: '' }, t)).toBe('Changes wait until Apply finishes.');
    expect(problemText({ code: 'notFound', message: 'uosc' }, t)).toBe(
      'This plugin is gone. The list was read again.',
    );
    expect(problemText({ code: 'unavailable', message: '' }, t)).toContain('could not be restarted');
    expect(problemText({ code: 'io', message: 'cannot save plugins.json' }, t)).toBe(
      'cannot save plugins.json',
    );
    expect(problemText({ code: 'io', message: '  ' }, t)).toBe('The change could not be made.');
    expect(problemText({ code: 'generic', message: 'boom' }, t)).toBe('The change could not be made.');
  });

  test('follows the language', () => {
    setLanguage('cs');
    try {
      expect(problemText({ code: 'busy', message: '' }, i18next.t)).toBe(
        'Změny počkají, až Použít skončí.',
      );
    } finally {
      setLanguage('en');
    }
  });
});

describe('the texts of a plugin', () => {
  test('localized takes Czech where there is one, else English', () => {
    expect(localized({ en: 'Seek previews', cs: 'Náhledy' }, 'cs')).toBe('Náhledy');
    expect(localized({ en: 'Seek previews', cs: 'Náhledy' }, 'cs-CZ')).toBe('Náhledy');
    expect(localized({ en: 'Seek previews' }, 'cs')).toBe('Seek previews');
    expect(localized({ en: 'Seek previews', cs: 'Náhledy' }, 'en')).toBe('Seek previews');
  });

  test('listOf puts names in a sentence’s list', () => {
    expect(listOf(['reload'], 'en')).toBe('reload');
    expect(listOf(['reload', 'sub-select'], 'en')).toBe('reload and sub-select');
    expect(listOf(['reload', 'sub-select'], 'cs')).toBe('reload a sub-select');
  });
});
