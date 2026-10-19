import i18next from 'i18next';
import { beforeAll, describe, expect, test } from 'vitest';

import { initI18n } from '../i18n';
import { normalizeText, searchSettings } from './search';

beforeAll(() => {
  // Both languages are in memory; a fixed `t` asks for one without switching the app's.
  initI18n('en');
});

const czech = () => i18next.getFixedT('cs');
const english = () => i18next.getFixedT('en');
const ids = (query: string, t: ReturnType<typeof czech>) =>
  searchSettings(query, t).map((descriptor) => descriptor.id);

describe('normalizing', () => {
  test('case and diacritics are taken off', () => {
    expect(normalizeText('Příliš žluťoučký kůň')).toBe('prilis zlutoucky kun');
    expect(normalizeText('ČEŠTINA')).toBe('cestina');
    expect(normalizeText('Písmo')).toBe('pismo');
    expect(normalizeText('plain')).toBe('plain');
    expect(normalizeText('')).toBe('');
  });
});

describe('searching the settings', () => {
  test('search finds settings without diacritics', () => {
    // "pismo" finds "Písmo titulků", whatever the case and with or without the accents.
    expect(czech()('settings.items.subFont.label')).toBe('Písmo titulků');
    expect(ids('pismo', czech())).toEqual(['sub-font']);
    expect(ids('PISMO', czech())).toEqual(['sub-font']);
    expect(ids('písmo', czech())).toEqual(['sub-font']);
    expect(ids('Písmo titulků', czech())).toEqual(['sub-font']);
    expect(ids('pismo titulku', czech())).toEqual(['sub-font']);
    // The same the other way round: the accents are in the query, not in the text.
    expect(ids('pokracovat', czech())).toEqual(['save-position-on-quit']);
    expect(ids('Pokračovat', czech())).toEqual(['save-position-on-quit']);
  });

  test('English is searched by its own texts', () => {
    expect(ids('font', english())).toEqual(['sub-font']);
    expect(ids('FONT', english())).toEqual(['sub-font']);
    // The Czech label is not an English word.
    expect(ids('pismo', english())).toEqual([]);
  });

  test('the keywords find a setting its label does not name', () => {
    expect(ids('gpu', english())).toEqual(['hwdec', 'profile']);
    expect(ids('grafická karta', czech())).toEqual(['hwdec']);
    expect(ids('graficka karta', czech())).toEqual(['hwdec']);
  });

  test('every word of the query has to be found, not necessarily in one place', () => {
    expect(ids('subtitle color', english())).toEqual([
      'sub-color',
      'sub-border-color',
      'sub-back-color',
    ]);
    expect(ids('color subtitle', english())).toEqual([
      'sub-color',
      'sub-border-color',
      'sub-back-color',
    ]);
    expect(ids('subtitle zzz', english())).toEqual([]);
  });

  test('the name of a section finds its settings', () => {
    expect(ids('audio', english())).toEqual(['audio-device', 'volume', 'volume-max', 'alang']);
    expect(ids('zvuk', czech())).toEqual(['audio-device', 'volume', 'volume-max', 'alang']);
  });

  test('a query with no words, or with no match, finds nothing', () => {
    expect(ids('', english())).toEqual([]);
    expect(ids('   ', english())).toEqual([]);
    expect(ids('zzzz', english())).toEqual([]);
  });

  test('the results keep the order of the settings', () => {
    const found = ids('volume', english());
    expect(found).toEqual(['volume', 'volume-max']);
  });

  test('search finds yt-dlp, Deno, cookies and quality', () => {
    // yt-dlp is named by the three rows that are about links; Deno has no row of its own, so the
    // channel row (whose keywords name it) brings the Updates section, which shows both tools.
    expect(ids('yt-dlp', english())).toEqual([
      'ytdl-format',
      'playback.cookiesFromBrowser',
      'updates.ytdlpChannel',
    ]);
    expect(ids('Deno', english())).toEqual(['updates.ytdlpChannel']);
    expect(ids('cookies', english())).toEqual(['playback.cookiesFromBrowser']);
    // The quality of the link and the quality preset of the picture are both "quality".
    expect(ids('quality', english())).toEqual(['ytdl-format', 'profile']);
    expect(ids('stream quality', english())).toEqual(['ytdl-format']);
    expect(ids('updates', english())).toEqual(['updates.ytdlpChannel']);
    expect(ids('nightly', english())).toEqual(['updates.ytdlpChannel']);
  });

  test('the same words are found in Czech, with or without the accents', () => {
    expect(ids('yt-dlp', czech())).toEqual([
      'ytdl-format',
      'playback.cookiesFromBrowser',
      'updates.ytdlpChannel',
    ]);
    expect(ids('deno', czech())).toEqual(['updates.ytdlpChannel']);
    expect(ids('cookies', czech())).toEqual(['playback.cookiesFromBrowser']);
    expect(ids('prohlizec', czech())).toEqual(['playback.cookiesFromBrowser']);
    expect(ids('kvalita', czech())).toEqual(['ytdl-format', 'profile']);
    expect(ids('Výchozí kvalita', czech())).toEqual(['ytdl-format']);
    expect(ids('aktualizace', czech())).toEqual(['updates.ytdlpChannel']);
    expect(ids('kanal', czech())).toEqual(['updates.ytdlpChannel']);
  });

  test('the new rows do not change what the other words find', () => {
    // The words the older tests (and the page's) lean on still find the same settings.
    expect(ids('language', english())).toEqual(['slang', 'alang', 'language']);
    expect(ids('audio', english())).toEqual(['audio-device', 'volume', 'volume-max', 'alang']);
    expect(ids('playlist', english())).toEqual(['autocreate-playlist', 'playback.openWhilePlaying']);
    expect(ids('gpu', english())).toEqual(['hwdec', 'profile']);
    expect(ids('zvuk', czech())).toEqual(['audio-device', 'volume', 'volume-max', 'alang']);
  });
});
