/**
 * The notices the error cards show (spec 10.1, 10.2, 10.3, 10.4; Ruling R40): a file or a link that
 * cannot be played (`shell/notices/ErrorCards.tsx` makes those from `end-file`; a link that failed
 * for a reason Rust knows carries its class and its address, for the action of the class), a plugin
 * that reports errors (from `plugins:error`) and the two notices of the app itself, a Ctrl+V that
 * found no link and a dropped link that Rust refused. At most `MAX_NOTICES` are kept, the newest
 * first; the oldest goes when a new one needs its place, but not a card whose action is running
 * (a plugin being disabled, a link being tried again). A notice goes by itself after `NOTICE_MS`
 * (not while its action runs, the pointer is over it or the focus is in it) or when it is closed
 * (`shell/notices/ErrorCard.tsx`).
 *
 * Other code adds one with `pushAppNotice` or `pushPluginNotice`; the card stack is the only reader.
 */

import { create } from 'zustand';

import type { LogLine, StreamError } from '../ipc/types';
import type { PluginProblem } from '../plugins/problem';

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

/**
 * Where the action of a link's card stands (spec 10.3), once it has one (`streamErrorAction`):
 *
 * - `idle`: the action is offered.
 * - `working`: it runs ("Update and try again" updates yt-dlp, which downloads; "Use and try again"
 *   saves the browser first). The card stays until it is done.
 * - `refused`: Rust did not take the link again (`stream_retry` rejected); the action is offered again.
 * - `unsaved`: the choice of the browser could not be saved, so nothing was changed.
 *
 * When the action succeeds the card goes: the link is with the player, and a new failure is a new card.
 */
export type RetryPhase = 'idle' | 'working' | 'refused' | 'unsaved';

/** A file or a link that could not be played. */
export interface PlaybackNotice extends NoticeBase {
  kind: 'playback';
  /** The file or the host of the link; empty where Rust could not say which file it was. */
  name: string;
  remedy: PlaybackRemedy;
  /** mpv's own word for the error (`loading failed`), shown in the details. */
  error: string | null;
  /** The last lines of mpv's log, oldest first. */
  lines: readonly LogLine[];
  /** Why yt-dlp failed, where Rust knows (`message` is the sentence of the class); `null` for a file. */
  stream: StreamError | null;
  /** The link that failed, for "Try again"; `null` for a file and where Rust did not name it. */
  url: string | null;
  retry: RetryPhase;
}

/**
 * Where the card of a plugin that reports errors stands (spec 10.4). Nothing is turned off by
 * itself: the card offers "Disable", and it is the user's word.
 *
 * - `ask`: "Disable" is offered.
 * - `working`: "Disable" runs. The card stays until it is done.
 * - `off`: the plugin is off. A plugin that runs keeps running until Apply, which the card says.
 * - `failed`: it could not be turned off (`problem` says why); "Disable" is offered again.
 */
export type PluginPhase = 'ask' | 'working' | 'off' | 'failed';

/** A plugin that logged errors (its first of this run, `plugins:error`). */
export interface PluginNotice extends NoticeBase {
  kind: 'plugin';
  /** `PluginInfo.name`: what the plugin commands take. */
  name: string;
  phase: PluginPhase;
  /** Why it could not be turned off; set exactly in `failed`. */
  problem: PluginProblem | null;
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

export type Notice = PlaybackNotice | PluginNotice | AppNotice;

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

export interface NoticeState {
  /** Newest first. */
  notices: Notice[];
  /**
   * Adds a notice on top and returns its id. An app notice that is already shown (the same text)
   * is replaced rather than stacked, so that a key pressed three times is one card with a new timer.
   * A plugin has one card at a time: a second notice for it adds nothing and gives the id of the
   * card that is there.
   */
  push: (notice: WithoutId<Notice>) => number;
  dismiss: (id: number) => void;
  /** Moves the card of a plugin on (`problem` with `failed`); a card that is gone is left alone. */
  setPluginPhase: (id: number, phase: PluginPhase, problem?: PluginProblem | null) => void;
  /** Moves the action of a link's card on; a card that is gone, or is no playback card, is left alone. */
  setRetryPhase: (id: number, retry: RetryPhase) => void;
  /** Adds a line to the details of a playback notice that is still there; the newest `DETAIL_LINES` stay. */
  addLogLine: (id: number, line: LogLine) => void;
}

let lastId = 0;

/**
 * A card whose action runs (a plugin being disabled, a link being tried again): it is not pushed out
 * and does not go by itself.
 */
export const isWorking = (notice: Notice): boolean =>
  (notice.kind === 'plugin' && notice.phase === 'working') ||
  (notice.kind === 'playback' && notice.retry === 'working');

/**
 * The newest `MAX_NOTICES`: the oldest go, apart from a card whose action runs, which stays while
 * any other can go instead (when every card is at work, the oldest goes all the same). The one on
 * top is the notice that was just added, and it stays.
 */
function trimmed(notices: Notice[]): Notice[] {
  const kept = [...notices];
  while (kept.length > MAX_NOTICES) {
    let drop = kept.length - 1;
    while (drop > 0 && isWorking(kept[drop])) drop -= 1;
    kept.splice(drop > 0 ? drop : kept.length - 1, 1);
  }
  return kept;
}

export const useNoticeStore = create<NoticeState>()((set, get) => ({
  notices: [],
  push: (notice) => {
    if (notice.kind === 'plugin') {
      const there = get().notices.find((other) => other.kind === 'plugin' && other.name === notice.name);
      if (there) return there.id;
    }
    lastId += 1;
    const id = lastId;
    set((state) => {
      const kept =
        notice.kind === 'app'
          ? state.notices.filter((other) => !(other.kind === 'app' && other.message === notice.message))
          : state.notices;
      return { notices: trimmed([{ ...notice, id }, ...kept]) };
    });
    return id;
  },
  setPluginPhase: (id, phase, problem = null) => {
    set((state) => {
      const target = state.notices.find((notice) => notice.id === id);
      if (target?.kind !== 'plugin') return state;
      return {
        notices: state.notices.map((notice) =>
          notice === target ? { ...target, phase, problem: phase === 'failed' ? problem : null } : notice,
        ),
      };
    });
  },
  setRetryPhase: (id, retry) => {
    set((state) => {
      const target = state.notices.find((notice) => notice.id === id);
      if (target?.kind !== 'playback' || target.retry === retry) return state;
      return {
        notices: state.notices.map((notice) => (notice === target ? { ...target, retry } : notice)),
      };
    });
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

/**
 * Puts the card of a plugin that reports errors on the stack (spec 10.4): the plugin keeps
 * running, and the card offers to disable it. Called once for a plugin in a run of the app, when
 * Rust says `plugins:error`.
 */
export function pushPluginNotice(name: string): void {
  useNoticeStore.getState().push({
    kind: 'plugin',
    message: 'errors.plugin.message',
    name,
    phase: 'ask',
    problem: null,
  });
}

/** Puts a notice of the app on the card stack: `message` is a key of the locale files. */
export function pushAppNotice(message: string, tone: AppNotice['tone'] = 'alert'): void {
  useNoticeStore.getState().push({ kind: 'app', message, tone });
}
