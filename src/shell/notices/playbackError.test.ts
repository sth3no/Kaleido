import i18next from 'i18next';
import { beforeAll, describe, expect, test } from 'vitest';

import { initI18n, LANGUAGES } from '../../i18n';
import { playbackErrorKey, playbackErrorKind, playbackRemedy } from './playbackError';

describe('playbackErrorKind', () => {
  // The strings are libmpv's mpv_error_string for the codes a file can end with
  // (crates/mpv-ffi/src/event.rs puts them in `end-file`'s `error`).
  test.each([
    ['loading failed', 'notFound'],
    ['unrecognized file format', 'unsupported'],
    ['not supported', 'unsupported'],
    ['no audio or video data played', 'unsupported'],
    ['video output initialization failed', 'generic'],
    ['audio output initialization failed', 'generic'],
    ['something happened', 'generic'],
    ['an error that no libmpv has told yet', 'generic'],
    ['', 'generic'],
  ])('mpv says "%s": %s', (error, kind) => {
    expect(playbackErrorKind(error)).toBe(kind);
  });

  test('no error string at all is the generic message', () => {
    expect(playbackErrorKind(null)).toBe('generic');
  });

  test('capitals and the edges of the string do not matter', () => {
    expect(playbackErrorKind(' Loading Failed\n')).toBe('notFound');
    expect(playbackErrorKind('UNRECOGNIZED FILE FORMAT')).toBe('unsupported');
  });

  test('a word that an object has finds nothing', () => {
    for (const word of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(playbackErrorKind(word), word).toBe('generic');
    }
  });
});

describe('playbackErrorKey', () => {
  beforeAll(() => {
    initI18n('en');
  });

  test('is the key of the text for the kind', () => {
    expect(playbackErrorKey('loading failed')).toBe('errors.playback.notFound');
    expect(playbackErrorKey('not supported')).toBe('errors.playback.unsupported');
    expect(playbackErrorKey('something happened')).toBe('errors.playback.generic');
    expect(playbackErrorKey(null)).toBe('errors.playback.generic');
  });

  test('every kind has its own text in both languages', () => {
    const keys = ['loading failed', 'unrecognized file format', null].map(playbackErrorKey);
    expect(new Set(keys).size).toBe(3);
    for (const language of LANGUAGES) {
      const texts = keys.map((key) => i18next.t(key, { lng: language }));
      for (const [index, key] of keys.entries()) {
        expect(i18next.exists(key, { lng: language }), `${language}: ${key}`).toBe(true);
        // A missing key is answered with the key itself.
        expect(texts[index], `${language}: ${key}`).not.toBe(key);
      }
      expect(new Set(texts).size, language).toBe(3);
    }
  });
});

describe('playbackRemedy', () => {
  const list = (current: number, ...files: string[]) => ({
    playlist: files.map((filename, index) => (index === current ? { filename, current: true } : { filename })),
  });

  test('continues where another entry follows the one that failed', () => {
    const props = list(0, 'C:\\Videa\\a.mkv', 'C:\\Videa\\b.mkv', 'C:\\Videa\\c.mkv');
    expect(playbackRemedy(props, 'C:\\Videa\\a.mkv')).toBe('continues');
    expect(playbackRemedy(props, 'C:\\Videa\\b.mkv')).toBe('continues');
  });

  test('is open where the failed entry was the last: the failure left nothing to play', () => {
    expect(playbackRemedy(list(0, 'C:\\Videa\\a.mkv'), 'C:\\Videa\\a.mkv')).toBe('open');
    expect(playbackRemedy(list(1, 'a.mkv', 'b.mkv'), 'b.mkv')).toBe('open');
  });

  test('goes by where the failed file stood, not by the entry that is current now', () => {
    // mpv has gone on: the current entry is the last, but the one that failed was the first.
    expect(playbackRemedy(list(2, 'a.mkv', 'b.mkv', 'c.mkv'), 'a.mkv')).toBe('continues');
    // The other way round: the current entry is the first, but the one that failed was the last.
    expect(playbackRemedy(list(0, 'a.mkv', 'b.mkv', 'c.mkv'), 'c.mkv')).toBe('open');
  });

  test('is open where Rust could not say which file failed, or the playlist does not have it', () => {
    expect(playbackRemedy(list(0, 'a.mkv', 'b.mkv'), null)).toBe('open');
    expect(playbackRemedy(list(0, 'a.mkv', 'b.mkv'), 'other.mkv')).toBe('open');
    expect(playbackRemedy({}, 'a.mkv')).toBe('open');
    expect(playbackRemedy({ playlist: [] }, 'a.mkv')).toBe('open');
  });

  test('finds a long path by the way it is shown', () => {
    const props = list(0, '\\\\?\\C:\\Videa\\a.mkv', 'C:\\Videa\\b.mkv');
    expect(playbackRemedy(props, '\\\\?\\C:\\Videa\\a.mkv')).toBe('continues');
  });

  test('a file that is twice in the list is the one that plays', () => {
    // [a, b, a]: the current a is the last one, so nothing follows; the first a is not the one.
    expect(playbackRemedy(list(2, 'a.mkv', 'b.mkv', 'a.mkv'), 'a.mkv')).toBe('open');
    expect(playbackRemedy(list(0, 'a.mkv', 'b.mkv', 'a.mkv'), 'a.mkv')).toBe('continues');
  });
});
