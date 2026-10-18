/**
 * What the About page works out of what Rust gives it (spec 8.10, 11.6), without React: the
 * versions in the diagnostics text, and the search of the licenses.
 */

import type { License } from '../ipc/types';
import { normalizeText } from './search';

/** The versions the page lists, `null` for one the diagnostics could not find out. */
export interface Versions {
  libmpv: string | null;
  ffmpeg: string | null;
}

/**
 * The versions in the diagnostics (`system_diagnostics`): a line each, `libmpv: <version>` and
 * `FFmpeg: <version>`, in English whatever the language of the UI (Rust: `diagnostics::render`).
 * What Rust could not read is `unknown` there, and a line that is not there is not an answer either.
 */
export function parseVersions(diagnostics: string): Versions {
  const valueOf = (name: string): string | null => {
    for (const line of diagnostics.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon < 0 || line.slice(0, colon).trim().toLowerCase() !== name) continue;
      const value = line.slice(colon + 1).trim();
      return value === '' || value.toLowerCase() === 'unknown' ? null : value;
    }
    return null;
  };
  return { libmpv: valueOf('libmpv'), ffmpeg: valueOf('ffmpeg') };
}

/**
 * The licenses that match `query`: every word of it has to occur in the name, the version, the
 * license or the address, ignoring case and accents. A query with no words matches everything.
 */
export function filterLicenses(licenses: readonly License[], query: string): License[] {
  const words = normalizeText(query)
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return [...licenses];
  return licenses.filter((entry) => {
    const haystack = normalizeText([entry.name, entry.version, entry.license, entry.url].join(' '));
    return words.every((word) => haystack.includes(word));
  });
}
