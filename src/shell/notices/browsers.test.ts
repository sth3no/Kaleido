import { describe, expect, test } from 'vitest';

import cs from '../../i18n/locales/cs.json';
import en from '../../i18n/locales/en.json';
import type { Browser } from '../../ipc/types';
import { isUnusable, noteKeyOf, orderBrowsers } from './browsers';

const browser = (
  id: string,
  label: string,
  spec: string,
  warning: Browser['warning'] = null,
): Browser => ({ id, label, spec, warning });

const FIREFOX = browser('firefox', 'Firefox', 'firefox');
const EDGE = browser('edge', 'Microsoft Edge', 'edge', 'chromiumCookies');
const CHROME = browser('chrome', 'Google Chrome', 'chrome', 'chromiumCookies');
const LIBREWOLF = browser('librewolf', 'LibreWolf', 'firefox:abc123.default-release');
const ZEN = browser('zen', 'Zen', '', 'noProfile');
/** As Rust lists them: Firefox first, the Chromium browsers, then the forks of Firefox. */
const FOUND = [FIREFOX, EDGE, CHROME, LIBREWOLF, ZEN];

describe('orderBrowsers', () => {
  test('Firefox and its forks come first, the Chromium browsers after, the ones without a profile last', () => {
    expect(orderBrowsers(FOUND).map((item) => item.id)).toEqual([
      'firefox',
      'librewolf',
      'edge',
      'chrome',
      'zen',
    ]);
  });

  test('Rust\'s order is kept within each group, and the list it was given is not changed', () => {
    const list = [CHROME, EDGE, ZEN, FIREFOX];
    const before = [...list];

    expect(orderBrowsers(list).map((item) => item.id)).toEqual(['firefox', 'chrome', 'edge', 'zen']);
    expect(list).toEqual(before);
  });

  test('an entry with nothing to save goes last, whatever its warning says', () => {
    const odd = browser('arc', 'Arc', '', null);

    expect(orderBrowsers([odd, EDGE, FIREFOX]).map((item) => item.id)).toEqual(['firefox', 'edge', 'arc']);
  });
});

describe('isUnusable', () => {
  test('an entry with no spec or with the no-profile warning cannot be chosen; the others can', () => {
    expect(isUnusable(ZEN)).toBe(true);
    expect(isUnusable(browser('arc', 'Arc', '', null))).toBe(true);
    expect(isUnusable(browser('zen', 'Zen', 'firefox:abc', 'noProfile'))).toBe(true);
    // A warning about the cookies does not forbid the choice.
    expect(isUnusable(EDGE)).toBe(false);
    expect(isUnusable(FIREFOX)).toBe(false);
    expect(isUnusable(LIBREWOLF)).toBe(false);
  });
});

describe('noteKeyOf', () => {
  test('a browser that works has nothing to say', () => {
    expect(noteKeyOf(FIREFOX)).toBeNull();
    expect(noteKeyOf(LIBREWOLF)).toBeNull();
  });

  test('a Chromium browser says that yt-dlp mostly cannot read its cookies', () => {
    expect(noteKeyOf(EDGE)).toBe('errors.browser.chromiumCookies');
    expect(noteKeyOf(CHROME)).toBe('errors.browser.chromiumCookies');
  });

  test('an entry with no profile says so', () => {
    expect(noteKeyOf(ZEN)).toBe('errors.browser.noProfile');
  });

  test('an entry that cannot be chosen says why, whatever else its warning is', () => {
    // No spec to save with no warning at all, and with the Chromium one.
    expect(noteKeyOf(browser('arc', 'Arc', '', null))).toBe('errors.browser.noProfile');
    expect(noteKeyOf(browser('arc', 'Arc', '', 'chromiumCookies'))).toBe('errors.browser.noProfile');
    // The warning alone, with a spec.
    expect(noteKeyOf(browser('zen', 'Zen', 'firefox:abc', 'noProfile'))).toBe('errors.browser.noProfile');
  });

  test('every sentence it names exists in both languages', () => {
    const keys = [EDGE, ZEN].map((item) => noteKeyOf(item) ?? '');
    for (const tree of [cs, en]) {
      for (const key of keys) {
        const text = key
          .split('.')
          .reduce<unknown>(
            (node, part) =>
              typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined,
            tree,
          );
        expect(typeof text, key).toBe('string');
        expect((text as string).trim(), key).not.toBe('');
      }
    }
  });

  test('names the sentence of each entry of the list, in the order the lists show it', () => {
    // The chooser of a card and the field of Settings both read their sentences from here.
    expect(orderBrowsers(FOUND).map(noteKeyOf)).toEqual([
      null,
      null,
      'errors.browser.chromiumCookies',
      'errors.browser.chromiumCookies',
      'errors.browser.noProfile',
    ]);
  });
});
