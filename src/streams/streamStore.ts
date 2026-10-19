/**
 * What is known of the qualities of the link that plays (spec 8.5, point 2), as Rust says it:
 * `formats` is the last `stream:formats` for the current `path` (or what `stream_formats` answered),
 * for the Quality tab of quick settings and the Quality button of the controls.
 *
 * - A link is a `path` that starts with `http://` or `https://`. `stream:formats` comes for any
 *   link; only the one for the current `path` is taken (`apply`), the rest is for a link that plays
 *   later or played before.
 * - The event may come before the UI knows the `path` (Rust probes as soon as the link starts to
 *   load), so the store asks `stream_formats` whenever `path` becomes a link (`followStreamPath`,
 *   which the bridge starts before it asks for the player's state). What is taken from the answer
 *   is not older than the newest event (`version`), as in `pluginsStore`.
 * - `select` sends the choice (`player_set_quality`) and says whether Rust took it. A choice is a
 *   reload like any open: the entry that plays ends, the player shows its loading title and goes on
 *   at the same position (Ruling R13), so the choice is `pending` only for the round trip of the
 *   command, for the list to show it at work. Rust's `chosen` is what is marked, not the click; the
 *   list shows it when the panel is opened again. A choice Rust refuses is `refused`, for the list
 *   to say so on that option.
 * - `path` passes through `null` while a link reloads: the formats stay then, and are shown only
 *   while `path` is the link they belong to.
 */

import { create } from 'zustand';

import { playerSetQuality, streamFormats } from '../ipc/commands';
import type { StreamFormats } from '../ipc/types';
import { usePlayerStore, type PlayerProps } from '../state/playerStore';
import type { QualityOption } from './quality';

const LINK = /^https?:\/\//i;

/** What `stream_formats` answers is a state of a link, or `null`; anything else is not taken. */
const isFormats = (value: unknown): value is StreamFormats =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Partial<StreamFormats>).url === 'string';

/** The link that plays: mpv's `path` when it is an http(s) link, else `null`. */
export function selectStreamUrl(props: PlayerProps): string | null {
  const path = props['path'];
  return typeof path === 'string' && LINK.test(path) ? path : null;
}

/** A choice that was sent: the one Rust has not answered yet, or the one it refused. */
export interface PendingQuality {
  /** The link it was sent for. */
  url: string;
  /** The `ytdl-format` sent; `null` for Automatic. */
  selector: string | null;
}

export interface StreamData {
  /** The latest state of a link taken, which is for the current one while `path` is that link. */
  formats: StreamFormats | null;
  /** The choice whose command has not returned yet. */
  pending: PendingQuality | null;
  /** The newest choice Rust refused (`QualityError`), until the next choice or another link. */
  refused: PendingQuality | null;
  /** Counts the states taken, so that an answer that was asked for earlier does not undo one. */
  version: number;
  /** A `stream:formats` came: taken if it is for the link that plays. */
  apply: (payload: StreamFormats) => void;
  /** Asks Rust what is known of the link that plays, and takes the answer. */
  ask: () => Promise<void>;
  /** `path` changed to `url` (a link, or `null` for what is no link). */
  pathChanged: (url: string | null) => void;
  /**
   * Plays the link in the quality of `option`; resolves with whether Rust took it. A choice that
   * changes nothing (the quality is that already, or is being sent) and one for what is no link
   * send nothing and resolve with `false`.
   */
  select: (option: QualityOption) => Promise<boolean>;
}

const currentUrl = (): string | null => selectStreamUrl(usePlayerStore.getState().props);

export const useStreamStore = create<StreamData>()((set, get) => ({
  formats: null,
  pending: null,
  refused: null,
  version: 0,

  apply: (payload) => {
    if (payload.url !== currentUrl()) return;
    set((state) => ({ formats: payload, version: state.version + 1 }));
  },

  ask: async () => {
    const version = get().version;
    let answer: unknown;
    try {
      answer = await streamFormats();
    } catch (error) {
      console.warn('stream_formats', error);
      return;
    }
    // An event that came while Rust was asked is newer than its answer.
    if (isFormats(answer) && get().version === version) get().apply(answer);
  },

  pathChanged: (url) => {
    if (url === null) return;
    // Another link: what was known of the one before, and a choice for it, are not about this one.
    set((state) => ({
      formats: state.formats?.url === url ? state.formats : null,
      pending: state.pending?.url === url ? state.pending : null,
      refused: state.refused?.url === url ? state.refused : null,
    }));
    void get().ask();
  },

  select: async (option) => {
    const url = currentUrl();
    if (url === null) return false;
    const { formats, pending } = get();
    // What the link is set to, or about to be: choosing it again changes nothing.
    const current =
      pending?.url === url ? pending.selector : formats?.url === url ? formats.chosen : null;
    if (option.selector === current) return false;

    const mine: PendingQuality = { url, selector: option.selector };
    set({ pending: mine, refused: null });
    let taken = false;
    try {
      await playerSetQuality(option.selector);
      taken = true;
    } catch (error) {
      // `notAStream` or `invalid`: nothing changed.
      console.warn('player_set_quality', error);
    }
    // Only the newest choice has a say: a later one has taken the place of this one.
    if (get().pending === mine) set({ pending: null, refused: taken ? null : mine });
    return taken;
  },
}));

/** The qualities known of the link that plays; `null` for none, and for what is no link. */
export function useStreamFormats(): StreamFormats | null {
  const url = usePlayerStore((state) => selectStreamUrl(state.props));
  const formats = useStreamStore((state) => state.formats);
  return url !== null && formats?.url === url ? formats : null;
}

/** The choice of the link that plays whose command has not returned yet, or `null`. */
export function usePendingQuality(): PendingQuality | null {
  const url = usePlayerStore((state) => selectStreamUrl(state.props));
  const pending = useStreamStore((state) => state.pending);
  return url !== null && pending?.url === url ? pending : null;
}

/** The choice of the link that plays that Rust refused, or `null`. */
export function useRefusedQuality(): PendingQuality | null {
  const url = usePlayerStore((state) => selectStreamUrl(state.props));
  const refused = useStreamStore((state) => state.refused);
  return url !== null && refused?.url === url ? refused : null;
}

/**
 * Follows `path` for as long as the bridge runs, and asks for the qualities of each link it
 * becomes; returns what stops it. A link that is there already (the UI starts while it plays) is
 * asked for at once. The events are the bridge's own subscription (`apply`).
 */
export function followStreamPath(): () => void {
  const stop = usePlayerStore.subscribe((state, previous) => {
    const url = selectStreamUrl(state.props);
    if (url !== selectStreamUrl(previous.props)) useStreamStore.getState().pathChanged(url);
  });
  const url = currentUrl();
  if (url !== null) useStreamStore.getState().pathChanged(url);
  return stop;
}
