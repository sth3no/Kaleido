import { describe, expect, test } from 'vitest';

import type { Track } from '../ipc/types';
import { channelLayout, displayNamesIn, languageName, trackLabel, type Translate } from './trackName';

/** A `t` that shows which key was asked for, and with what. */
const t: Translate = (key, options) => (options ? `${key}:${JSON.stringify(options)}` : key);

describe('languageName', () => {
  test('is the name of the language in the language of the UI, with a capital', () => {
    expect(languageName('cs', 'en')).toBe('Czech');
    expect(languageName('eng', 'en')).toBe('English');
    expect(languageName('en', 'cs')).toBe('Angličtina');
  });

  test('reads the codes of the files the same as the ones ICU knows', () => {
    // `cze` is the bibliographic code of Czech, `ces` the terminology one.
    expect(languageName('cze', 'en')).toBe(languageName('ces', 'en'));
    expect(languageName('ger', 'en')).toBe(languageName('deu', 'en'));
    expect(languageName('CS', 'en')).toBe('Czech');
  });

  test('keeps one Intl.DisplayNames per language, not one per label', () => {
    expect(displayNamesIn('en')).toBe(displayNamesIn('en'));
    expect(displayNamesIn('cs')).toBe(displayNamesIn('cs'));
    expect(displayNamesIn('cs')).not.toBe(displayNamesIn('en'));
    // Asked through languageName, the same one answers: the name does not change.
    expect(languageName('cs', 'en')).toBe(languageName('cs', 'en'));
  });

  test('is null where the file names no language', () => {
    expect(languageName(undefined, 'en')).toBeNull();
    expect(languageName('', 'en')).toBeNull();
    expect(languageName('  ', 'en')).toBeNull();
    expect(languageName('und', 'en')).toBeNull();
  });
});

describe('channelLayout', () => {
  test('names the layouts people name by their numbers', () => {
    expect(channelLayout(1)).toBe('1.0');
    expect(channelLayout(2)).toBe('2.0');
    expect(channelLayout(6)).toBe('5.1');
    expect(channelLayout(8)).toBe('7.1');
  });

  test('is empty for any other count, and for none', () => {
    expect(channelLayout(3)).toBe('');
    expect(channelLayout(0)).toBe('');
    expect(channelLayout(undefined)).toBe('');
  });
});

describe('trackLabel', () => {
  const sub = (fields: Partial<Track>): Track => ({ id: 1, type: 'sub', ...fields });

  test('is the language and the title, and nothing under them for a plain track', () => {
    expect(trackLabel(sub({ lang: 'cs', title: 'SDH' }), t, 'en')).toEqual({
      name: 'Czech · SDH',
      detail: '',
    });
    expect(trackLabel(sub({ lang: 'cs' }), t, 'en')).toEqual({ name: 'Czech', detail: '' });
    expect(trackLabel(sub({ title: 'Signs & songs' }), t, 'en')).toEqual({
      name: 'Signs & songs',
      detail: '',
    });
  });

  test('is the language in the language of the UI', () => {
    expect(trackLabel(sub({ lang: 'en' }), t, 'cs').name).toBe('Angličtina');
  });

  test('a title that only repeats the language is left out', () => {
    expect(trackLabel(sub({ lang: 'en', title: 'english' }), t, 'en').name).toBe('English');
  });

  test('is "Track N" when the file says nothing', () => {
    expect(trackLabel(sub({ id: 3 }), t, 'en')).toEqual({
      name: 'panels.track.fallback:{"id":3}',
      detail: '',
    });
    expect(trackLabel(sub({ id: 4, lang: 'und', title: '  ' }), t, 'en').name).toBe(
      'panels.track.fallback:{"id":4}',
    );
  });

  test('says under the name that a track is forced, and which file an external one is', () => {
    expect(
      trackLabel(
        sub({ lang: 'en', forced: true, external: true, 'external-filename': 'C:\\Titulky\\film.cs.srt' }),
        t,
        'en',
      ).detail,
    ).toBe('panels.track.forced · film.cs.srt');
    expect(trackLabel(sub({ lang: 'en', external: true }), t, 'en').detail).toBe('panels.track.external');
  });

  test('an external track that says nothing itself is named by its file', () => {
    const file = 'C:\\Titulky\\film.cs.srt';
    expect(trackLabel(sub({ id: 5, external: true, 'external-filename': file }), t, 'en')).toEqual({
      name: 'film.cs.srt',
      detail: 'panels.track.external',
    });
    // Forced as well: both under the name.
    expect(
      trackLabel(sub({ external: true, forced: true, 'external-filename': file }), t, 'en'),
    ).toEqual({ name: 'film.cs.srt', detail: 'panels.track.forced · panels.track.external' });
    // Without the file's name there is only the number.
    expect(trackLabel(sub({ id: 6, external: true }), t, 'en')).toEqual({
      name: 'panels.track.fallback:{"id":6}',
      detail: 'panels.track.external',
    });
    // A track with a language keeps it, and the file goes under it.
    expect(
      trackLabel(sub({ lang: 'cs', external: true, 'external-filename': file }), t, 'en'),
    ).toEqual({ name: 'Czech', detail: 'film.cs.srt' });
  });

  test('a sound has its codec and its channels under the name; a subtitle track does not', () => {
    const sound: Track = {
      id: 2,
      type: 'audio',
      lang: 'cs',
      codec: 'eac3',
      'demux-channel-count': 6,
    };
    expect(trackLabel(sound, t, 'en')).toEqual({ name: 'Czech', detail: 'EAC3 · 5.1' });
    expect(trackLabel({ ...sound, 'demux-channel-count': 3 }, t, 'en').detail).toBe('EAC3');
    expect(trackLabel(sub({ lang: 'cs', codec: 'subrip' }), t, 'en').detail).toBe('');
  });
});
