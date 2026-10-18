/**
 * What a file or an entry of the playlist is called: the name of the file, for a link its host (the
 * last part of a link's address says little), and a title from mpv where it has one. Paths come
 * without the `\\?\` of long ones.
 */

import {
  displayPath,
  fileName,
  selectPlaylist,
  type PlayerProps,
  type PlaylistItem,
} from '../state/playerStore';

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
 * What a path or a link is called: its file name, or the host of a link. Empty for `null`, which is
 * what Rust sends where it does not know the file.
 */
export function nameOfFile(file: string | null): string {
  if (file === null || file === '') return '';
  return linkHost(file) ?? fileName(file);
}

/**
 * The name of an entry of the playlist: its title if it has one, else the file name, or the host
 * of a link.
 */
export function entryName(entry: PlaylistItem): string {
  const host = linkHost(entry.filename);
  // `title` is the playlist's own title, or else `fileName`: only the second is replaced by the host.
  return host !== null && entry.title === fileName(entry.filename) ? host : entry.title;
}

/**
 * The name of the entry that is current (`entryName`). Empty without a current entry.
 */
export function currentEntryName(props: PlayerProps): string {
  const entry = selectPlaylist(props).find((item) => item.current);
  return entry ? entryName(entry) : '';
}

/** What mpv's `filename` property says for a link: the part after the last `/`, %-escapes undone. */
function addressTails(link: string): string[] {
  const tail = link.slice(link.lastIndexOf('/') + 1);
  let unescaped = tail;
  try {
    unescaped = decodeURIComponent(tail);
  } catch {
    // Not valid escapes: the tail as it is.
  }
  return [link, tail, unescaped, fileName(link)];
}

/**
 * mpv's `media-title` where it is a title, `''` where it is not one yet. Until the demuxer has a
 * title mpv answers with its `filename` property, which for a link is the tail of the address
 * (`watch?v=abc`), at once: that names nothing, and the host of the entry does better.
 */
export function knownTitle(props: PlayerProps): string {
  const title = props['media-title'];
  if (typeof title !== 'string' || title === '') return '';
  const entry = selectPlaylist(props).find((item) => item.current);
  if (entry && linkHost(entry.filename) !== null && addressTails(entry.filename).includes(title)) {
    return '';
  }
  return displayPath(title);
}
