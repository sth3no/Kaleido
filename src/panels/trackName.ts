/**
 * What a track of the file is called in the lists of quick settings: the language in the language
 * of the UI (from the tag mpv reports) and the title the file gives it, and underneath what tells
 * tracks of one language apart (forced, an external file, the codec and the channels of a sound).
 */

import type { Track } from '../ipc/types';
import { nameOfFile } from '../player/entryName';

/** The texts a label needs (the `t` of react-i18next). */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface TrackLabel {
  /** The line to read: `Čeština · SDH`, or `Track 3` when the file says nothing. */
  name: string;
  /** The line under it; empty for none. */
  detail: string;
}

/**
 * Matroska and most tools tag languages with the "bibliographic" ISO 639-2 codes, which ICU does not
 * always know (`cze`); these are the ones that differ from the "terminology" code it does.
 */
const BIBLIOGRAPHIC: Readonly<Record<string, string>> = {
  alb: 'sqi',
  arm: 'hye',
  baq: 'eus',
  bur: 'mya',
  chi: 'zho',
  cze: 'ces',
  dut: 'nld',
  fre: 'fra',
  geo: 'kat',
  ger: 'deu',
  gre: 'ell',
  ice: 'isl',
  mac: 'mkd',
  mao: 'mri',
  may: 'msa',
  per: 'fas',
  rum: 'ron',
  slo: 'slk',
  tib: 'bod',
  wel: 'cym',
};

/** The first letter capital, as a name in a list reads (Czech language names are lower case). */
function capitalized(text: string, locale: string): string {
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

/**
 * The name of a language in `locale` from the tag of a track (`cs`, `cze`, `eng`); `null` where the
 * file names none (or says `und`). A code the system does not know is shown as it is, in capitals.
 */
export function languageName(tag: string | undefined, locale: string): string | null {
  const code = tag?.trim().toLowerCase();
  if (!code || code === 'und') return null;
  try {
    const names = new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' });
    const name = names.of(BIBLIOGRAPHIC[code] ?? code);
    return name ? capitalized(name, locale) : code.toUpperCase();
  } catch {
    // Not a language tag at all (a word the muxer wrote): as it is.
    return tag?.trim() ?? null;
  }
}

/** The channel layouts people name by their numbers. */
const CHANNELS: Readonly<Record<number, string>> = { 1: '1.0', 2: '2.0', 6: '5.1', 8: '7.1' };

/** The layout of a sound with `count` channels (`5.1`); empty where it has no usual name. */
export function channelLayout(count: number | undefined): string {
  return count === undefined ? '' : (CHANNELS[count] ?? '');
}

/** What `track` is called in a list, in the language of the UI (`locale`). */
export function trackLabel(track: Track, t: Translate, locale: string): TrackLabel {
  const language = languageName(track.lang, locale);
  const title = track.title?.trim();
  const names: string[] = [];
  if (language) names.push(language);
  // A title that only repeats the language adds nothing.
  if (title && title.toLowerCase() !== language?.toLowerCase()) names.push(title);

  const detail: string[] = [];
  if (track.forced === true) detail.push(t('panels.track.forced'));
  if (track.external === true) {
    detail.push(nameOfFile(track['external-filename'] ?? null) || t('panels.track.external'));
  }
  if (track.type === 'audio') {
    if (track.codec) detail.push(track.codec.toUpperCase());
    const layout = channelLayout(track['demux-channel-count']);
    if (layout) detail.push(layout);
  }

  return {
    name: names.length > 0 ? names.join(' · ') : t('panels.track.fallback', { id: track.id }),
    detail: detail.join(' · '),
  };
}
