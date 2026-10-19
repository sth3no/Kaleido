import i18next from 'i18next';
import { beforeAll, describe, expect, test } from 'vitest';

import { initI18n, LANGUAGES } from '../../i18n';
import type { StreamError } from '../../ipc/types';
import { streamErrorAction, streamErrorKey, type StreamAction } from './streamError';

/** The table of spec 10.3. A `Record`: a class that Rust learns makes this test fail to compile. */
const TABLE: Record<StreamError, StreamAction | null> = {
  outdated: 'update',
  missing: 'update',
  signIn: 'cookies',
  ageRestricted: 'cookies',
  cookies: 'cookies',
  geoBlocked: null,
  private: null,
  removed: null,
  network: 'retry',
};

const CLASSES = Object.keys(TABLE) as StreamError[];

beforeAll(() => {
  initI18n('en');
});

describe('streamErrorAction', () => {
  test.each(CLASSES.map((error): [StreamError, StreamAction | null] => [error, TABLE[error]]))(
    'each stream error class has its action: %s -> %s',
    (error, action) => {
      expect(streamErrorAction(error)).toBe(action);
    },
  );

  test('an out-of-date or missing yt-dlp is updated, a login or an age asks for cookies, the network is tried again', () => {
    expect(CLASSES.filter((error) => streamErrorAction(error) === 'update')).toEqual(['outdated', 'missing']);
    expect(CLASSES.filter((error) => streamErrorAction(error) === 'cookies')).toEqual([
      'signIn',
      'ageRestricted',
      'cookies',
    ]);
    expect(CLASSES.filter((error) => streamErrorAction(error) === 'retry')).toEqual(['network']);
  });

  test('a region, a private video and a removed one are only explained', () => {
    for (const error of ['geoBlocked', 'private', 'removed'] as const) {
      expect(streamErrorAction(error), error).toBeNull();
    }
  });
});

describe('streamErrorKey', () => {
  test('is the key of the sentence of the class', () => {
    expect(streamErrorKey('outdated')).toBe('errors.stream.outdated');
    expect(streamErrorKey('ageRestricted')).toBe('errors.stream.ageRestricted');
    expect(streamErrorKey('cookies')).toBe('errors.stream.cookies');
  });

  test('every class has its own text in both languages', () => {
    const keys = CLASSES.map(streamErrorKey);
    expect(new Set(keys).size).toBe(CLASSES.length);
    for (const language of LANGUAGES) {
      const texts = keys.map((key) => i18next.t(key, { lng: language }));
      for (const [index, key] of keys.entries()) {
        expect(i18next.exists(key, { lng: language }), `${language}: ${key}`).toBe(true);
        // A missing key is answered with the key itself.
        expect(texts[index], `${language}: ${key}`).not.toBe(key);
      }
      expect(new Set(texts).size, language).toBe(CLASSES.length);
    }
  });

  test('the text of the cookies class says that the cookies of the chosen browser cannot be read', () => {
    expect(i18next.t(streamErrorKey('cookies'), { lng: 'en' })).toMatch(/cookies of the chosen browser/i);
    expect(i18next.t(streamErrorKey('cookies'), { lng: 'cs' })).toMatch(/cookies zvoleného prohlížeče/i);
  });

  test('every action has its button text and its progress text in both languages', () => {
    const keys = [
      'update',
      'retry',
      'cookies',
      'updating',
      'retrying',
      'saving',
      'refused',
      'unsaved',
    ].map((name) => `errors.streamAction.${name}`);
    for (const language of LANGUAGES) {
      for (const key of keys) {
        expect(i18next.exists(key, { lng: language }), `${language}: ${key}`).toBe(true);
        expect(i18next.t(key, { lng: language }), `${language}: ${key}`).not.toBe(key);
      }
    }
    expect(i18next.t('errors.streamAction.update', { lng: 'cs' })).toBe('Aktualizovat a zkusit znovu');
    expect(i18next.t('errors.streamAction.cookies', { lng: 'cs' })).toBe('Použít cookies z prohlížeče');
  });
});
