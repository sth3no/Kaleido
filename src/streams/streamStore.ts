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
 * - `select` sends the choice (`player_set_quality`); the store marks it `pending` until the
 *   `stream:formats` that carries it as `chosen` arrives, or `PENDING_MS` pass, so that the list can
 *   show the choice at work. Rust's `chosen` is what is marked, not the click.
 * - `path` can pass through `null` while a link reloads in place (a quality is changed): the
 *   formats stay then, and are shown only while `path` is the link they belong to.
 */

import { create } from 'zustand';

import { playerSetQuality, streamFormats } from '../ipc/commands';
import type { StreamFormats } from '../ipc/types';
import { usePlayerStore, type PlayerProps } from '../state/playerStore';
import type { QualityOption } from './quality';

/** How long a choice is shown at work without Rust confirming it, ms. */
export const PENDING_MS = 10_000;

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

/** A choice that was sent and that Rust has not confirmed yet. */
export interface PendingQuality {
  /** The link it was sent for. */
  url: string;
  /** The `ytdl-format` sent; `null` for Automatic. */
  selector: string | null;
}

export interface StreamData {
  /** The latest state of a link taken, which is for the current one while `path` is that link. */
  formats: StreamFormats | null;
  pending: PendingQuality | null;
  /** Counts the states taken, so that an answer that was asked for earlier does not undo one. */
  version: number;
  /** A `stream:formats` came: taken if it is for the link that plays. */
  apply: (payload: StreamFormats) => void;
  /** Asks Rust what is known of the link that plays, and takes the answer. */
  ask: () => Promise<void>;
  /** `path` changed to `url` (a link, or `null` for what is no link). */
  pathChanged: (url: string | null) => void;
  /** Plays the link in the quality of `option`. */
  select: (option: QualityOption) => Promise<void>;
}

/** The timer that ends the pending state; there is one pending choice at a time. */
let pendingTimer: ReturnType<typeof setTimeout> | undefined;

function stopPendingTimer(): void {
  clearTimeout(pendingTimer);
  pendingTimer = undefined;
}

const currentUrl = (): string | null => selectStreamUrl(usePlayerStore.getState().props);

export const useStreamStore = create<StreamData>()((set, get) => ({
  formats: null,
  pending: null,
  version: 0,

  apply: (payload) => {
    if (payload.url !== currentUrl()) return;
    set((state) => {
      const { pending } = state;
      const confirmed =
        pending !== null && pending.url === payload.url && pending.selector === payload.chosen;
      return {
        formats: payload,
        version: state.version + 1,
        pending: confirmed ? null : pending,
      };
    });
    if (get().pending === null) stopPendingTimer();
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
    }));
    if (get().pending === null) stopPendingTimer();
    void get().ask();
  },

  select: async (option) => {
    const url = currentUrl();
    if (url === null) return;
    const { formats, pending } = get();
    // What the link is set to, or about to be: choosing it again changes nothing.
    const current =
      pending?.url === url ? pending.selector : formats?.url === url ? formats.chosen : null;
    if (option.selector === current) return;

    const mine: PendingQuality = { url, selector: option.selector };
    const drop = () => {
      if (get().pending !== mine) return;
      stopPendingTimer();
      set({ pending: null });
    };
    stopPendingTimer();
    set({ pending: mine });
    pendingTimer = setTimeout(drop, PENDING_MS);
    try {
      await playerSetQuality(option.selector);
    } catch (error) {
      // `notAStream` or `invalid`: nothing changed, and there is nothing to wait for.
      console.warn('player_set_quality', error);
      drop();
    }
  },
}));

/** The qualities known of the link that plays; `null` for none, and for what is no link. */
export function useStreamFormats(): StreamFormats | null {
  const url = usePlayerStore((state) => selectStreamUrl(state.props));
  const formats = useStreamStore((state) => state.formats);
  return url !== null && formats?.url === url ? formats : null;
}

/** The choice of the link that plays that Rust has not confirmed yet, or `null`. */
export function usePendingQuality(): PendingQuality | null {
  const url = usePlayerStore((state) => selectStreamUrl(state.props));
  const pending = useStreamStore((state) => state.pending);
  return url !== null && pending?.url === url ? pending : null;
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
