/**
 * What the About page works out of what Rust gives it (spec 8.10, 11.6), without React: the
 * versions in the diagnostics text, the version of the tools in the list of licenses, and the search
 * of the licenses.
 */

import { systemDiagnostics } from '../ipc/commands';
import type { License, ToolId } from '../ipc/types';
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
 * Reads the versions out of the diagnostics Rust writes. A diagnostics that cannot be read leaves them
 * unknown (and goes to the console), so that the page around them still works. The About page and
 * Settings → Updates (the libmpv) read them the same way.
 */
export async function readVersions(): Promise<Versions> {
  try {
    const text = await systemDiagnostics();
    return parseVersions(typeof text === 'string' ? text : '');
  } catch (error) {
    console.warn('cannot read the versions in the diagnostics', error);
    return { libmpv: null, ffmpeg: null };
  }
}

/**
 * What the licenses file (resources/licenses/extra.json) writes as the version of a tool that Kaleido
 * downloads and updates itself: there is no version to print until the tool is there.
 */
export const MANAGED_VERSION = 'managed';

/** The managed tools, by the name their entry has in the list of licenses. */
const TOOL_OF_LICENSE = new Map<string, ToolId>([
  ['yt-dlp', 'ytDlp'],
  ['Deno', 'deno'],
]);

/**
 * The licenses with the version of the managed tools put in: `versionOf(tool)` is what the page says
 * for yt-dlp and Deno (their real version, or why there is none) in place of the word `managed`.
 * Every other entry is as it was.
 */
export function withToolVersions(
  licenses: readonly License[],
  versionOf: (tool: ToolId) => string,
): License[] {
  return licenses.map((entry) => {
    const tool = entry.version === MANAGED_VERSION ? TOOL_OF_LICENSE.get(entry.name) : undefined;
    return tool === undefined ? entry : { ...entry, version: versionOf(tool) };
  });
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
