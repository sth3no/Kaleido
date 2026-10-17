import i18next from 'i18next';
import { describe, expect, test } from 'vitest';

import { initI18n, LANGUAGES, type ResolvedLanguage } from './index';
import cs from './locales/cs.json';
import en from './locales/en.json';

const locales: Record<ResolvedLanguage, unknown> = { cs, en };

/** Every text of a locale file: its path (`settings.language.label`) and what stands there. */
function leaves(tree: unknown, prefix = ''): [path: string, value: unknown][] {
  if (typeof tree === 'object' && tree !== null && !Array.isArray(tree)) {
    return Object.entries(tree).flatMap(([key, child]) =>
      leaves(child, prefix === '' ? key : `${prefix}.${key}`),
    );
  }
  return [[prefix, tree]];
}

/** i18next's plural forms (JSON v4): `files_one`, `files_few`, `files_other`. */
const PLURAL_FORM = /_(zero|one|two|few|many|other)$/;

/** The key a text is asked for by: the forms of a plural are one key. */
const baseKey = (path: string): string => path.replace(PLURAL_FORM, '');

const keysOf = (tree: unknown): Set<string> => new Set(leaves(tree).map(([path]) => baseKey(path)));

/** The keys of `from` that `to` lacks. */
const missing = (from: Set<string>, to: Set<string>): string[] =>
  [...from].filter((key) => !to.has(key)).sort();

/** The names of the `{{placeholders}}` in a text. */
const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{\{\s*([\w.]+)/g)].map((match) => match[1] ?? '').sort();

describe('the locale files', () => {
  test('every key exists in both languages', () => {
    const csKeys = keysOf(cs);
    const enKeys = keysOf(en);
    // Not vacuous: there are keys to compare.
    expect(enKeys.size).toBeGreaterThan(0);
    expect(missing(enKeys, csKeys), 'in en.json, missing from cs.json').toEqual([]);
    expect(missing(csKeys, enKeys), 'in cs.json, missing from en.json').toEqual([]);
  });

  test('no empty translations', () => {
    for (const language of LANGUAGES) {
      const texts = leaves(locales[language]);
      expect(texts.length, language).toBeGreaterThan(0);
      const bad = texts
        .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
        .map(([path]) => path);
      expect(bad, `${language}.json: empty, or not a text`).toEqual([]);
    }
  });

  test('has a group of texts for each part of the app, and none of them is empty', () => {
    for (const language of LANGUAGES) {
      const tree = locales[language] as Record<string, unknown>;
      expect(Object.keys(tree), language).toEqual(
        expect.arrayContaining(['shell', 'home', 'player', 'panels', 'settings', 'errors']),
      );
      for (const [group, texts] of Object.entries(tree)) {
        expect(leaves(texts).length, `${language}.json: ${group}`).toBeGreaterThan(0);
      }
    }
  });

  test('a text has the same placeholders in both languages', () => {
    const czech = new Map(leaves(cs));
    for (const [path, text] of leaves(en)) {
      const other = czech.get(path);
      if (typeof text !== 'string' || typeof other !== 'string') continue;
      expect(placeholders(other), path).toEqual(placeholders(text));
    }
  });

  test('a plural has the forms its language needs', () => {
    for (const language of LANGUAGES) {
      const needed = new Intl.PluralRules(language).resolvedOptions().pluralCategories.sort();
      const found = new Map<string, string[]>();
      for (const [path] of leaves(locales[language])) {
        const form = PLURAL_FORM.exec(path)?.[1];
        if (form === undefined) continue;
        found.set(baseKey(path), [...(found.get(baseKey(path)) ?? []), form]);
      }
      for (const [key, forms] of found) {
        expect(forms.sort(), `${language}.json: ${key}`).toEqual(needed);
      }
    }
  });

  test('every text can be asked for with its path, in its own language', () => {
    // A key with a `.` or a `:` in its name would split into other keys and never be found.
    initI18n('en');
    for (const language of LANGUAGES) {
      for (const [path, text] of leaves(locales[language])) {
        if (typeof text === 'string' && !text.includes('{{')) {
          expect(i18next.t(path, { lng: language }), `${language}: ${path}`).toBe(text);
        }
      }
    }
  });
});

describe('the checks above', () => {
  test('a key that one side lacks is found, and the forms of a plural are one key', () => {
    const wide = keysOf({
      files: { title: 'a', count_one: '1', count_few: '2', count_other: '3' },
      extra: 'e',
    });
    const narrow = keysOf({ files: { title: 'a', count_one: '1', count_other: '3' } });

    expect([...narrow].sort()).toEqual(['files.count', 'files.title']);
    expect(missing(wide, narrow)).toEqual(['extra']);
    expect(missing(narrow, wide)).toEqual([]);
  });

  test('texts that are empty or not texts are found', () => {
    const bad = leaves({ a: '', b: '  ', c: 1, d: ['x'], e: { f: 'ok' } })
      .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
      .map(([path]) => path);

    expect(bad).toEqual(['a', 'b', 'c', 'd']);
  });

  test('placeholders are read by name', () => {
    expect(placeholders('{{count}} of {{ total }} files')).toEqual(['count', 'total']);
    expect(placeholders('no placeholders')).toEqual([]);
  });
});
