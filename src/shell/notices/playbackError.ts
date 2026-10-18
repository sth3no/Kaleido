/**
 * What to tell the user about a file that could not be played (spec 10.2), from the `error` of
 * `player:end-file`. That string is libmpv's `mpv_error_string` of the error code of the end of the
 * file (crates/mpv-ffi/src/event.rs, src-tauri/src/player/state.rs): a short fixed phrase and
 * nothing else, the reason itself is in mpv's log (the card's "Details").
 *
 * The codes a file can end with, and what the card says:
 *
 * | mpv's string                      | kind          | why                                              |
 * |-----------------------------------|---------------|--------------------------------------------------|
 * | `loading failed`                  | `notFound`    | the source did not open: missing, moved, offline |
 * | `unrecognized file format`        | `unsupported` | no demuxer knows it: not media, or damaged       |
 * | `not supported`                   | `unsupported` | a format or feature mpv does not have            |
 * | `no audio or video data played`   | `unsupported` | nothing in the file could be played              |
 * | anything else (also no string)    | `generic`     | output failures (`video output initialization    |
 * |                                   |               | failed`), `something happened`, a newer libmpv   |
 *
 * `loading failed` is all mpv says for a missing file, a 404, a host that does not answer and a
 * file that cannot be read, so the text for it names those causes together.
 *
 * What the card offers besides (spec 10.1, Ruling R41) depends on what mpv did, and mpv always
 * goes on with the playlist by itself (spec 10.2): see `playbackRemedy`.
 */

import { displayPath, selectPlaylist, type PlayerProps } from '../../state/playerStore';
import type { PlaybackRemedy } from '../../state/noticeStore';

export type PlaybackErrorKind = 'notFound' | 'unsupported' | 'generic';

/** A `Map`, not an object: a string like `constructor` must not find anything. */
const KINDS = new Map<string, PlaybackErrorKind>([
  ['loading failed', 'notFound'],
  ['unrecognized file format', 'unsupported'],
  ['not supported', 'unsupported'],
  ['no audio or video data played', 'unsupported'],
]);

/** The kind of the error: the table above. */
export function playbackErrorKind(error: string | null): PlaybackErrorKind {
  if (error === null) return 'generic';
  return KINDS.get(error.trim().toLowerCase()) ?? 'generic';
}

/** The key of the card's text in the locale files: `errors.playback.notFound`, `.unsupported` or `.generic`. */
export function playbackErrorKey(error: string | null): string {
  return `errors.playback.${playbackErrorKind(error)}`;
}

/**
 * What the card says is going on, from where the failed file stood in the playlist when it failed
 * (not from the entry that is current later: mpv moves on at once, and the entry that plays then
 * was never seen to fail):
 *
 * - `continues`: an entry follows the failed one, so mpv goes on with it.
 * - `open`: it was the last, or Rust could not say which file failed, or the playlist (as the UI
 *   has it) does not have it: nothing is known to play next, and the way on is to open a file.
 *
 * `file` is `end-file`'s: the `filename` of the failed entry, to be found in the playlist's.
 */
export function playbackRemedy(props: PlayerProps, file: string | null): PlaybackRemedy {
  if (file === null) return 'open';
  const list = selectPlaylist(props);
  const shown = displayPath(file);
  const same = list.filter((item) => item.filename === shown);
  // The same file twice: the one that plays, else the first.
  const failed = same.find((item) => item.current) ?? same[0];
  if (failed === undefined) return 'open';
  return list.indexOf(failed) < list.length - 1 ? 'continues' : 'open';
}
