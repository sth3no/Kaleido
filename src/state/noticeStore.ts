/**
 * The notices the error cards show (spec 10.1, 10.2; Ruling R40): a file that cannot be played
 * (`shell/notices/ErrorCards.tsx` makes those from `end-file`) and the two notices of the app
 * itself, a Ctrl+V that found no link and a dropped link that Rust refused. At most `MAX_NOTICES`
 * are kept, the newest first; the oldest goes when a new one needs its place. A notice goes by
 * itself after `NOTICE_MS` or when it is closed (`shell/notices/ErrorCard.tsx`).
 *
 * Other code adds one with `pushAppNotice`; the card stack is the only reader.
 */

import { create } from 'zustand';

import type { LogLine } from '../ipc/types';

/** Cards on top of one another. */
export const MAX_NOTICES = 3;

/** How long a card stays, ms. */
export const NOTICE_MS = 8000;

/** How many lines of mpv's log a playback card keeps for its "Details". */
export const DETAIL_LINES = 8;

interface NoticeBase {
  id: number;
  /** The key of the text in the locale files (`errors.…`), so that a language switch applies to it. */
  message: string;
}

/**
 * What the card of a file that could not be played has to say about what happens now (spec 10.1,
 * Rulings R41, R43), from `continues` of `player:end-file`:
 *
 * - `continues`: mpv goes on by itself (another entry follows, or the playlist loops).
 * - `open`: it does not, or Rust could not tell; the user has to open something.
 */
export type PlaybackRemedy = 'continues' | 'open';

/** A file that could not be played. */
export interface PlaybackNotice extends NoticeBase {
  kind: 'playback';
  /** The file or the host of the link; empty where Rust could not say which file it was. */
  name: string;
  remedy: PlaybackRemedy;
  /** mpv's own word for the error (`loading failed`), shown in the details. */
  error: string | null;
  /** The last lines of mpv's log, oldest first. */
  lines: readonly LogLine[];
}

/** Something the app itself has to say. */
export interface AppNotice extends NoticeBase {
  kind: 'app';
  /**
   * `alert`: something the user asked for did not happen (read at once); `status`: a hint (read
   * when the reader is free).
   */
  tone: 'alert' | 'status';
}

export type Notice = PlaybackNotice | AppNotice;

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

export interface NoticeState {
  /** Newest first. */
  notices: Notice[];
  /**
   * Adds a notice on top and returns its id. An app notice that is already shown (the same text)
   * is replaced rather than stacked, so that a key pressed three times is one card with a new timer.
   */
  push: (notice: WithoutId<Notice>) => number;
  dismiss: (id: number) => void;
  /** Adds a line to the details of a playback notice that is still there; the newest `DETAIL_LINES` stay. */
  addLogLine: (id: number, line: LogLine) => void;
}

let lastId = 0;

export const useNoticeStore = create<NoticeState>()((set) => ({
  notices: [],
  push: (notice) => {
    lastId += 1;
    const id = lastId;
    set((state) => {
      const kept =
        notice.kind === 'app'
          ? state.notices.filter((other) => !(other.kind === 'app' && other.message === notice.message))
          : state.notices;
      return { notices: [{ ...notice, id }, ...kept].slice(0, MAX_NOTICES) };
    });
    return id;
  },
  dismiss: (id) => {
    set((state) =>
      state.notices.some((notice) => notice.id === id)
        ? { notices: state.notices.filter((notice) => notice.id !== id) }
        : state,
    );
  },
  addLogLine: (id, line) => {
    set((state) => {
      const target = state.notices.find((notice) => notice.id === id);
      if (target?.kind !== 'playback') return state;
      const lines = [...target.lines, line].slice(-DETAIL_LINES);
      return {
        notices: state.notices.map((notice) => (notice === target ? { ...target, lines } : notice)),
      };
    });
  },
}));

/** Puts a notice of the app on the card stack: `message` is a key of the locale files. */
export function pushAppNotice(message: string, tone: AppNotice['tone'] = 'alert'): void {
  useNoticeStore.getState().push({ kind: 'app', message, tone });
}
