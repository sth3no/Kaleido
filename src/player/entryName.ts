/**
 * What the current playlist entry is called while mpv does not know a title for it (yet): the name
 * of the file, or for a link its host. `media-title` is the better name when mpv has one, and the
 * loading title (`LoadingTitle.tsx`) takes that first.
 */

import { fileName, selectPlaylist, type PlayerProps } from '../state/playerStore';

/** The host of a link (never its user name or password), `null` for a path. */
export function linkHost(path: string): string | null {
  try {
    // A drive path parses as a link with the drive as its scheme, and has no host.
    const { host } = new URL(path);
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/**
 * The name of the entry that is current: its title if the playlist has one, else the file name, or
 * the host of a link (the last part of a link's address says little). Empty without a current entry.
 */
export function currentEntryName(props: PlayerProps): string {
  const entry = selectPlaylist(props).find((item) => item.current);
  if (!entry) return '';
  const host = linkHost(entry.filename);
  // `title` is the playlist's own title, or else `fileName`: only the second is replaced by the host.
  return host !== null && entry.title === fileName(entry.filename) ? host : entry.title;
}
