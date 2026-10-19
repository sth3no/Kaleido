/**
 * What the card of a link that did not play says and offers (spec 10.1, 10.3), from the
 * `streamError` of `player:end-file`: Rust sorts yt-dlp's failures into the classes of `StreamError`
 * (src-tauri/src/player/stream_error.rs), and each class has one sentence (`errors.stream.<class>`,
 * which the Quality tab of a probe that failed uses too) and at most one action:
 *
 * | class                                | action                                        |
 * |--------------------------------------|-----------------------------------------------|
 * | `outdated`, `missing`                | `update`: update yt-dlp (or fetch it), then try again |
 * | `signIn`, `ageRestricted`, `cookies` | `cookies`: choose the browser to take cookies from |
 * | `network`                            | `retry`: try again                            |
 * | `geoBlocked`, `private`, `removed`   | none: the card only explains                  |
 *
 * `cookies` is a failure of the choice itself (yt-dlp cannot read the cookies of the browser that
 * was chosen, mostly a Chromium browser on Windows, decision 19), so its chooser also offers to use
 * no cookies at all (`BrowserChooser.tsx`).
 */

import type { StreamError } from '../../ipc/types';

export type StreamAction = 'update' | 'cookies' | 'retry';

/** A `Record` over every class: a class that Rust learns makes this file fail to compile. */
const ACTIONS: Record<StreamError, StreamAction | null> = {
  outdated: 'update',
  missing: 'update',
  signIn: 'cookies',
  ageRestricted: 'cookies',
  cookies: 'cookies',
  geoBlocked: null,
  private: null,
  removed: null,
  network: 'retry',
};

/** The key of the class's sentence in the locale files: `errors.stream.outdated`, ... */
export function streamErrorKey(error: StreamError): string {
  return `errors.stream.${error}`;
}

/** What the card offers for the class (the table above); `null` where it only explains. */
export function streamErrorAction(error: StreamError): StreamAction | null {
  return ACTIONS[error];
}
