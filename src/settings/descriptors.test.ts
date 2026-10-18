import { describe, expect, test } from 'vitest';

import mpvKeysSource from '../../src-tauri/src/settings/mpv_keys.rs?raw';
import storeSource from '../../src-tauri/src/settings/store.rs?raw';
import cs from '../i18n/locales/cs.json';
import en from '../i18n/locales/en.json';
import {
  DESCRIPTORS,
  SECTIONS,
  descriptorsOf,
  getPath,
  isMpvTarget,
  patchFor,
  type SettingDescriptor,
} from './descriptors';

/** The text at a key such as `settings.items.hwdec.label` in a locale tree, `undefined` if there is none. */
function textAt(tree: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined,
      tree,
    );
}

/** Every key of texts a descriptor asks for. */
function keysOf(descriptor: SettingDescriptor): string[] {
  const keys = [descriptor.labelKey];
  if (descriptor.keywordsKey !== undefined) keys.push(descriptor.keywordsKey);
  if (descriptor.hintKey !== undefined) keys.push(descriptor.hintKey);
  const { field } = descriptor;
  if (field.kind === 'select') keys.push(...field.options.map((option) => option.labelKey));
  if (field.kind === 'slider' && field.unitKey !== undefined) keys.push(field.unitKey);
  return keys;
}

const mpvTarget = (descriptor: SettingDescriptor): string =>
  isMpvTarget(descriptor.target) ? descriptor.target.mpv : '';

describe('the descriptors', () => {
  test('every descriptor has labels in both languages', () => {
    expect(DESCRIPTORS.length).toBeGreaterThan(0);
    for (const descriptor of DESCRIPTORS) {
      for (const key of keysOf(descriptor)) {
        for (const [language, tree] of [
          ['cs', cs],
          ['en', en],
        ] as const) {
          const text = textAt(tree, key);
          expect(typeof text, `${language}.json lacks ${key} (${descriptor.id})`).toBe('string');
          expect((text as string).trim(), `${language}.json: ${key} is empty`).not.toBe('');
        }
      }
      // A label, and the words the search finds the setting by.
      expect(descriptor.keywordsKey, `${descriptor.id} has no keywords`).toBeDefined();
    }
    // The sections are named too.
    for (const section of SECTIONS) {
      expect(typeof textAt(cs, `settings.sections.${section}`), `cs ${section}`).toBe('string');
      expect(typeof textAt(en, `settings.sections.${section}`), `en ${section}`).toBe('string');
    }
  });

  test('ids are unique and a text key never has a dot in a value-derived part', () => {
    const ids = DESCRIPTORS.map((descriptor) => descriptor.id);
    expect(new Set(ids).size).toBe(ids.length);
    // `bt.2390` is an mpv value; its text is `bt2390`, since a `.` in a key would split it.
    const toneMapping = DESCRIPTORS.find((descriptor) => descriptor.id === 'tone-mapping');
    expect(toneMapping?.field.kind).toBe('select');
    if (toneMapping?.field.kind === 'select') {
      for (const option of toneMapping.field.options) {
        expect(option.labelKey.startsWith('settings.items.toneMapping.options.')).toBe(true);
        expect(option.labelKey.split('.')).toHaveLength(5);
      }
    }
  });

  test('the sections hold the settings spec 8.10 gives them, in that order', () => {
    const ids = (section: (typeof SECTIONS)[number]) =>
      descriptorsOf(section).map((descriptor) => descriptor.id);
    expect(ids('playback')).toEqual([
      'hwdec',
      'autocreate-playlist',
      'save-position-on-quit',
      'playback.openWhilePlaying',
    ]);
    expect(ids('subtitles')).toEqual([
      'sub-font',
      'sub-font-size',
      'sub-color',
      'sub-border-color',
      'sub-border-size',
      'sub-back-color',
      'slang',
    ]);
    expect(ids('audio')).toEqual(['audio-device', 'volume', 'volume-max', 'alang']);
    expect(ids('video')).toEqual([
      'deinterlace',
      'tone-mapping',
      'hdr-compute-peak',
      'profile',
      'glsl-shaders',
    ]);
    // The language is with the look (Ruling R48); the glass and the scale follow spec 8.5 point 4.
    expect(ids('appearance')).toEqual([
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
    // Lists of their own, not rows of settings (sections/Shortcuts.tsx, sections/About.tsx).
    expect(ids('shortcuts')).toEqual([]);
    expect(ids('about')).toEqual([]);
    expect(SECTIONS).toEqual([
      'playback',
      'subtitles',
      'audio',
      'video',
      'appearance',
      'shortcuts',
      'about',
    ]);
  });
});

/**
 * What Rust accepts: the allow-list `MPV_SETTINGS` of src-tauri/src/settings/mpv_keys.rs, read from the
 * source itself (a Vite `?raw` import) and compared with the descriptors, so that a key, a word or a
 * bound that changes on one side and not on the other fails here. The fields must not offer a value
 * that Rust would refuse, or miss an option it allows.
 *
 * The parse leans on the shape of that block (`live("key", ValueKind::Kind(...))` and `at_start(...)`,
 * one entry after the other, `&["word", ...]` for the words, `min: 0.0, max: 100.0` for the bounds). If
 * the block changes shape, the first test below fails on the parse, before anything else does.
 */
interface RustSetting {
  key: string;
  /** The `ValueKind` variant: `Choice`, `ChoiceOrNone`, `Flag`, `Number`, `Color`, ... */
  kind: string;
  /** `live(...)` as opposed to `at_start(...)`. */
  live: boolean;
  words: string[];
  min?: number;
  max?: number;
}

function parseAllowList(source: string): RustSetting[] {
  const start = source.indexOf('pub const MPV_SETTINGS');
  const end = source.indexOf('\n];', start);
  if (start < 0 || end < 0) throw new Error('MPV_SETTINGS is not where this test looks for it');
  // Comments out, so that a word in one is not taken for an entry.
  const block = source.slice(start, end).replace(/\/\/.*$/gm, '');
  const heads = [...block.matchAll(/\b(live|at_start)\(\s*"([^"]+)"\s*,\s*ValueKind::(\w+)/g)];
  return heads.map((head, index) => {
    const body = block.slice(head.index + head[0].length, heads[index + 1]?.index ?? block.length);
    const list = /&\[([^\]]*)\]/.exec(body)?.[1] ?? '';
    const min = /min:\s*(-?[\d.]+)/.exec(body)?.[1];
    const max = /max:\s*(-?[\d.]+)/.exec(body)?.[1];
    return {
      key: head[2] ?? '',
      kind: head[3] ?? '',
      live: head[1] === 'live',
      words: [...list.matchAll(/"([^"]*)"/g)].map((word) => word[1] ?? ''),
      min: min === undefined ? undefined : Number(min),
      max: max === undefined ? undefined : Number(max),
    };
  });
}

describe('the descriptors against the allow-list of mpv_keys.rs', () => {
  const rust = parseAllowList(mpvKeysSource);
  const byKey = (key: string): SettingDescriptor => {
    const found = DESCRIPTORS.find((descriptor) => mpvTarget(descriptor) === key);
    if (!found) throw new Error(`no descriptor for ${key}`);
    return found;
  };

  test('the allow-list is read from the Rust source', () => {
    // Not vacuous: the parse found the entries, with their kinds, words and bounds.
    expect(rust.length).toBeGreaterThanOrEqual(19);
    const hwdec = rust.find((setting) => setting.key === 'hwdec');
    expect(hwdec).toEqual({
      key: 'hwdec',
      kind: 'Choice',
      live: true,
      words: ['auto-safe', 'auto-copy-safe', 'no'],
      min: undefined,
      max: undefined,
    });
    const volume = rust.find((setting) => setting.key === 'volume');
    expect(volume).toMatchObject({ kind: 'Number', live: false, min: 0, max: 100 });
    expect(rust.find((setting) => setting.key === 'glsl-shaders')?.kind).toBe('Shaders');
    for (const setting of rust) {
      expect(setting.key, 'an entry without a key').not.toBe('');
      if (setting.kind === 'Choice' || setting.kind === 'ChoiceOrNone') {
        expect(setting.words.length, setting.key).toBeGreaterThan(0);
      }
      if (setting.kind === 'Number') {
        expect(setting.min, setting.key).toBeDefined();
        expect(setting.max, setting.key).toBeDefined();
      }
    }
  });

  test('every allowed option has a descriptor, and no other option has', () => {
    const used = DESCRIPTORS.map(mpvTarget).filter((key) => key !== '');
    expect([...used].sort()).toEqual(rust.map((setting) => setting.key).sort());
  });

  test('the sliders have the bounds Rust checks', () => {
    const numbers = rust.filter((setting) => setting.kind === 'Number');
    expect(numbers.map((setting) => setting.key).sort()).toEqual([
      'sub-border-size',
      'sub-font-size',
      'volume',
      'volume-max',
    ]);
    for (const setting of numbers) {
      const { field } = byKey(setting.key);
      expect(field.kind, setting.key).toBe('slider');
      if (field.kind === 'slider') {
        expect([field.min, field.max], setting.key).toEqual([setting.min, setting.max]);
        expect(field.step, setting.key).toBeGreaterThan(0);
        // The steps end on the maximum, so that it can be reached.
        const steps = (field.max - field.min) / field.step;
        expect(steps, setting.key).toBe(Math.round(steps));
      }
    }
  });

  test('the selects offer the words Rust accepts, and only those', () => {
    for (const setting of rust.filter((entry) => entry.kind === 'Choice')) {
      const { field } = byKey(setting.key);
      // A choice of two of the words is a toggle (the playlist from the folder); see below.
      if (field.kind !== 'select') continue;
      expect(field.options.map((option) => option.value).sort(), setting.key).toEqual(
        [...setting.words].sort(),
      );
    }
    // "None" is the empty word: `null`, which takes the option out of mpv.conf.
    for (const setting of rust.filter((entry) => entry.kind === 'ChoiceOrNone')) {
      const { field } = byKey(setting.key);
      expect(field.kind, setting.key).toBe('select');
      if (field.kind === 'select') {
        expect(field.options.map((option) => option.value).sort(), setting.key).toEqual(
          ['', ...setting.words].sort(),
        );
      }
    }
    // The selects there are, by name.
    expect(
      DESCRIPTORS.filter((descriptor) => descriptor.field.kind === 'select' && isMpvTarget(descriptor.target))
        .map(mpvTarget)
        .sort(),
    ).toEqual(['deinterlace', 'hdr-compute-peak', 'hwdec', 'profile', 'tone-mapping']);
  });

  test('the toggles use the words of their options', () => {
    // yes and no, left out: `Flag` is Rust's yes/no.
    for (const setting of rust.filter((entry) => entry.kind === 'Flag')) {
      expect(byKey(setting.key).field, setting.key).toEqual({ kind: 'toggle' });
    }
    // "Playlist from folder": filter and no, two of the three words of autocreate-playlist.
    const playlist = rust.find((setting) => setting.key === 'autocreate-playlist');
    const field = byKey('autocreate-playlist').field;
    expect(field).toEqual({ kind: 'toggle', on: 'filter', off: 'no' });
    expect(playlist?.words).toEqual(expect.arrayContaining(['filter', 'no']));
  });

  test('the other fields are of the kind of their values', () => {
    const kinds: Record<string, string> = {
      Color: 'color',
      Languages: 'langList',
      Font: 'font',
      AudioDevice: 'device',
      Shaders: 'shaderList',
    };
    const covered = rust.filter((setting) => setting.kind in kinds);
    expect(covered.map((setting) => setting.key).sort()).toEqual([
      'alang',
      'audio-device',
      'glsl-shaders',
      'slang',
      'sub-back-color',
      'sub-border-color',
      'sub-color',
      'sub-font',
    ]);
    for (const setting of covered) {
      expect(byKey(setting.key).field.kind, setting.key).toBe(kinds[setting.kind]);
    }
    // Every kind of value Rust has is accounted for by one of the checks.
    const known = ['Choice', 'ChoiceOrNone', 'Flag', 'Number', ...Object.keys(kinds)];
    expect(rust.filter((setting) => !known.includes(setting.kind))).toEqual([]);
  });

  test('the settings that do not apply at once say so; nothing else does', () => {
    // Rust's `at_start`: the default volume (R25) and the quality preset (R22).
    const atStartInRust = rust.filter((setting) => !setting.live).map((setting) => setting.key);
    expect(atStartInRust.sort()).toEqual(['profile', 'volume']);
    const hinted = DESCRIPTORS.filter(
      (descriptor) => descriptor.hintKey === 'settings.hints.atStart',
    ).map(mpvTarget);
    expect(hinted.sort()).toEqual(atStartInRust.sort());
  });

  test('Kaleido\'s own settings are paths into the settings', () => {
    const own = DESCRIPTORS.filter((descriptor) => !isMpvTarget(descriptor.target));
    expect(own.map((descriptor) => descriptor.target)).toEqual([
      { kaleido: 'playback.openWhilePlaying' },
      { kaleido: 'language' },
      { kaleido: 'appearance.mode' },
      { kaleido: 'appearance.accent' },
      { kaleido: 'appearance.glassTint' },
      { kaleido: 'appearance.glassOpacity' },
      { kaleido: 'appearance.blur' },
      { kaleido: 'appearance.saturation' },
      { kaleido: 'appearance.radius' },
      { kaleido: 'appearance.mica' },
      { kaleido: 'appearance.reduceTransparency' },
      { kaleido: 'appearance.uiScale' },
    ]);
    // The id of each is its path (the id of an mpv option is the option).
    for (const descriptor of own) {
      const path = isMpvTarget(descriptor.target) ? '' : descriptor.target.kaleido;
      expect(descriptor.id, descriptor.id).toBe(path);
    }
    const field = own[0]?.field;
    expect(field?.kind).toBe('select');
    if (field?.kind === 'select') {
      // `LoadMode` of ipc/types.ts.
      expect(field.options.map((option) => option.value)).toEqual(['replace', 'append']);
    }
  });
});

/**
 * What Rust accepts of the appearance and the language: the ranges and the enums of
 * src-tauri/src/settings/store.rs, read from the source itself and compared with the descriptors, so
 * that a bound or a word that changes on one side and not on the other fails here.
 */
describe('the appearance against store.rs', () => {
  /** `pub const GLASS_OPACITY: RangeInclusive<f64> = 0.3..=0.95;` as `[0.3, 0.95]`. */
  function rangeOf(name: string): [number, number] {
    const pattern = new RegExp(`pub const ${name}: RangeInclusive<f64> = (-?[\\d.]+)\\.\\.=(-?[\\d.]+);`);
    const found = pattern.exec(storeSource);
    if (!found) throw new Error(`store.rs has no range ${name} where this test looks for it`);
    return [Number(found[1]), Number(found[2])];
  }

  /** The variants of `pub enum Name { ... }`, as the lower case words serde writes. */
  function wordsOf(name: string): string[] {
    const body = new RegExp(`pub enum ${name} \\{([^}]*)\\}`).exec(storeSource)?.[1];
    if (body === undefined) throw new Error(`store.rs has no enum ${name} where this test looks for it`);
    return body
      .replace(/\/\/.*$/gm, '')
      .replace(/#\[[^\]]*\]/g, '')
      .split(',')
      .map((variant) => variant.trim().toLowerCase())
      .filter((variant) => variant !== '');
  }

  const own = (id: string): SettingDescriptor => {
    const found = DESCRIPTORS.find((descriptor) => descriptor.id === id);
    if (!found) throw new Error(`no descriptor ${id}`);
    return found;
  };
  const optionsOf = (id: string): string[] => {
    const { field } = own(id);
    if (field.kind !== 'select') throw new Error(`${id} is not a select`);
    return field.options.map((option) => option.value);
  };

  test('the ranges are read from the Rust source', () => {
    expect(rangeOf('GLASS_OPACITY')).toEqual([0.3, 0.95]);
    expect(rangeOf('BLUR')).toEqual([0, 40]);
    expect(rangeOf('UI_SCALE')).toEqual([0.9, 1.5]);
  });

  test('the sliders have the ranges Rust checks, and their steps end on the maximum', () => {
    const sliders: [id: string, range: string][] = [
      ['appearance.glassOpacity', 'GLASS_OPACITY'],
      ['appearance.blur', 'BLUR'],
      ['appearance.saturation', 'SATURATION'],
      ['appearance.radius', 'RADIUS'],
      ['appearance.uiScale', 'UI_SCALE'],
    ];
    for (const [id, range] of sliders) {
      const { field } = own(id);
      expect(field.kind, id).toBe('slider');
      if (field.kind !== 'slider') continue;
      expect([field.min, field.max], id).toEqual(rangeOf(range));
      expect(field.step, id).toBeGreaterThan(0);
      // The maximum can be reached (the float arithmetic is allowed its last digits).
      const steps = (field.max - field.min) / field.step;
      expect(Math.abs(steps - Math.round(steps)), id).toBeLessThan(1e-9);
    }
    // The ones that are fractions are written as percentages; the others have a unit of their own.
    const percent = DESCRIPTORS.flatMap((descriptor) =>
      descriptor.field.kind === 'slider' && descriptor.field.percent ? [descriptor.id] : [],
    );
    expect(percent).toEqual(['appearance.glassOpacity', 'appearance.saturation', 'appearance.uiScale']);
  });

  test('the selects offer the words of the enums Rust has, and only those', () => {
    expect(wordsOf('Language')).toEqual(['system', 'cs', 'en']);
    expect(optionsOf('language')).toEqual(wordsOf('Language'));
    expect(optionsOf('appearance.mode')).toEqual(wordsOf('ThemeMode'));
    expect(optionsOf('appearance.reduceTransparency')).toEqual(wordsOf('ReduceTransparency'));
  });

  test('the accent, the tint and Mica are the kinds of field their values are', () => {
    expect(own('appearance.accent').field).toEqual({ kind: 'accent' });
    // #RRGGBB: Rust checks the tint with six digits only.
    expect(own('appearance.glassTint').field).toEqual({ kind: 'color', alpha: false });
    expect(own('appearance.mica').field).toEqual({ kind: 'toggle' });
  });

  test('the language uses the texts of the language picker, which exist since Task 15', () => {
    const { field, labelKey } = own('language');
    expect(labelKey).toBe('settings.language.label');
    expect(field.kind === 'select' && field.options.map((option) => option.labelKey)).toEqual([
      'settings.language.system',
      'settings.language.cs',
      'settings.language.en',
    ]);
  });

  test('Mica has a text for the hint and one for why it is off, in both languages', () => {
    for (const key of ['settings.items.mica.hint', 'settings.items.mica.unavailable']) {
      for (const tree of [cs, en]) expect(typeof textAt(tree, key), key).toBe('string');
    }
    expect(own('appearance.mica').hintKey).toBe('settings.items.mica.hint');
  });
});

describe('paths into the settings', () => {
  test('a patch holds the changed setting only', () => {
    expect(patchFor('playback.openWhilePlaying', 'append')).toEqual({
      playback: { openWhilePlaying: 'append' },
    });
    expect(patchFor('language', 'cs')).toEqual({ language: 'cs' });
    expect(patchFor('appearance.blur', 12)).toEqual({ appearance: { blur: 12 } });
  });

  test('a value is read at its path, and nothing is made up for a path that is not there', () => {
    const settings = { version: 1, playback: { openWhilePlaying: 'append' } };
    expect(getPath(settings, 'playback.openWhilePlaying')).toBe('append');
    expect(getPath(settings, 'playback')).toEqual({ openWhilePlaying: 'append' });
    expect(getPath(settings, 'appearance.blur')).toBeUndefined();
    expect(getPath(settings, 'version.nothing')).toBeUndefined();
    expect(getPath(null, 'playback')).toBeUndefined();
  });
});
