import { describe, expect, test } from 'vitest';

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
    // Task 23 adds these.
    expect(ids('appearance')).toEqual([]);
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
 * What Rust accepts (MPV_SETTINGS in src-tauri/src/settings/mpv_keys.rs), written out again here:
 * the fields must not offer a value that Rust would refuse, or miss an option it allows.
 */
describe('the descriptors against the allow-list of mpv_keys.rs', () => {
  const byKey = (key: string): SettingDescriptor => {
    const found = DESCRIPTORS.find((descriptor) => mpvTarget(descriptor) === key);
    if (!found) throw new Error(`no descriptor for ${key}`);
    return found;
  };

  test('every allowed option has a descriptor, and no other option has', () => {
    const allowed = [
      'hwdec',
      'autocreate-playlist',
      'save-position-on-quit',
      'sub-font',
      'sub-font-size',
      'sub-color',
      'sub-border-color',
      'sub-back-color',
      'sub-border-size',
      'slang',
      'audio-device',
      'volume',
      'volume-max',
      'alang',
      'deinterlace',
      'tone-mapping',
      'hdr-compute-peak',
      'profile',
      'glsl-shaders',
    ];
    const used = DESCRIPTORS.map(mpvTarget).filter((key) => key !== '');
    expect([...used].sort()).toEqual([...allowed].sort());
  });

  test('the sliders have the bounds Rust checks', () => {
    const bounds: Record<string, [number, number]> = {
      'sub-font-size': [10, 120],
      'sub-border-size': [0, 10],
      volume: [0, 100],
      'volume-max': [100, 1000],
    };
    for (const [key, [min, max]] of Object.entries(bounds)) {
      const { field } = byKey(key);
      expect(field.kind, key).toBe('slider');
      if (field.kind === 'slider') {
        expect([field.min, field.max], key).toEqual([min, max]);
        expect(field.step, key).toBeGreaterThan(0);
        // The steps end on the maximum, so that it can be reached.
        expect((field.max - field.min) / field.step, key).toBe(Math.round((field.max - field.min) / field.step));
      }
    }
  });

  test('the selects offer the words Rust accepts, and only those', () => {
    const words: Record<string, string[]> = {
      hwdec: ['auto-safe', 'auto-copy-safe', 'no'],
      deinterlace: ['auto', 'no', 'yes'],
      'tone-mapping': [
        'auto',
        'clip',
        'mobius',
        'reinhard',
        'hable',
        'bt.2390',
        'bt.2446a',
        'spline',
        'st2094-40',
        'st2094-10',
      ],
      'hdr-compute-peak': ['auto', 'yes', 'no'],
      // The empty word is "none": `null`, which takes the option out of mpv.conf.
      profile: ['', 'fast', 'high-quality'],
    };
    for (const [key, expected] of Object.entries(words)) {
      const { field } = byKey(key);
      expect(field.kind, key).toBe('select');
      if (field.kind === 'select') {
        expect(field.options.map((option) => option.value).sort(), key).toEqual([...expected].sort());
      }
    }
  });

  test('the toggles use the words of their options', () => {
    // yes and no, left out.
    expect(byKey('save-position-on-quit').field).toEqual({ kind: 'toggle' });
    // "Playlist from folder": filter and no, two of autocreate-playlist's three words.
    expect(byKey('autocreate-playlist').field).toEqual({ kind: 'toggle', on: 'filter', off: 'no' });
  });

  test('the other fields are of the kind of their values', () => {
    const kinds: Record<string, string> = {
      'sub-font': 'font',
      'sub-color': 'color',
      'sub-border-color': 'color',
      'sub-back-color': 'color',
      slang: 'langList',
      alang: 'langList',
      'audio-device': 'device',
      'glsl-shaders': 'shaderList',
    };
    for (const [key, kind] of Object.entries(kinds)) {
      expect(byKey(key).field.kind, key).toBe(kind);
    }
  });

  test('volume and profile, which do not apply at once, say so; nothing else does', () => {
    const atStart = DESCRIPTORS.filter(
      (descriptor) => descriptor.hintKey === 'settings.hints.atStart',
    ).map((descriptor) => descriptor.id);
    // Rust's `live: false` keys (Rulings R22, R25).
    expect(atStart).toEqual(['volume', 'profile']);
  });

  test('Kaleido\'s own setting is a path into the settings', () => {
    const own = DESCRIPTORS.filter((descriptor) => !isMpvTarget(descriptor.target));
    expect(own.map((descriptor) => descriptor.target)).toEqual([
      { kaleido: 'playback.openWhilePlaying' },
    ]);
    const field = own[0]?.field;
    expect(field?.kind).toBe('select');
    if (field?.kind === 'select') {
      // `LoadMode` of ipc/types.ts.
      expect(field.options.map((option) => option.value)).toEqual(['replace', 'append']);
    }
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
