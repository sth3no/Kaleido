/**
 * The player's state as the UI sees it: mpv's observed properties, whether a file is loaded, why
 * the last file ended and the tail of mpv's log. The bridge (`bridge.ts`) feeds it; components
 * read it through the selectors at the bottom, which take the `props` record:
 *
 *   const paused = usePlayerStore((s) => selectPaused(s.props));
 *
 * Selectors that return a list give back the same array while the property did not change, so
 * they are safe as zustand selectors. `time-pos` changes 10 times a second: select it only where
 * it is drawn (see `useInterpolatedTime`).
 */

import { create } from 'zustand';

import type {
  Chapter,
  EndFile,
  LogLine,
  PlaylistEntry,
  Track,
  TrackKind,
} from '../ipc/types';

/** mpv's property name → value, as Rust sends it (`null` for a property without a value). */
export type PlayerProps = Record<string, unknown>;

/** How many lines of mpv's log the store keeps. */
export const LOG_TAIL_LIMIT = 50;

export interface PlayerState {
  props: PlayerProps;
  /** A file is loaded: set by `player:file-loaded`, cleared when a file ends. */
  loaded: boolean;
  /** The latest `player:end-file`; a new object for each, so an effect on it sees repeats. */
  lastEnd: EndFile | null;
  /** The last `LOG_TAIL_LIMIT` warnings and errors of mpv's log, oldest first. */
  logTail: LogLine[];
  /** Takes the player's whole state (the answer to `system_ui_ready`). */
  applySnapshot: (snapshot: PlayerProps) => void;
  /** Takes a `player:state` batch. */
  applyChanges: (changes: PlayerProps) => void;
  fileLoaded: () => void;
  endFile: (end: EndFile) => void;
  addLog: (line: LogLine) => void;
}

export const usePlayerStore = create<PlayerState>()((set) => ({
  props: {},
  loaded: false,
  lastEnd: null,
  logTail: [],
  applySnapshot: (snapshot) => {
    set((state) => ({
      props: { ...state.props, ...snapshot },
      // A UI that starts or reloads while a file plays never hears its `player:file-loaded`; the
      // snapshot says whether a file is loaded: something is open (not idle) and has a time or a
      // duration (Ruling R32). The reply can also come after `player:file-loaded` and be taken
      // right after `loadfile`, before mpv knew a time: a file that was heard loaded stays loaded
      // unless the snapshot says mpv is idle (Ruling R33).
      loaded:
        snapshot['idle-active'] === false &&
        (Number.isFinite(snapshot['time-pos']) ||
          Number.isFinite(snapshot['duration']) ||
          state.loaded),
    }));
  },
  applyChanges: (changes) => {
    set((state) => {
      // Nothing new (mpv repeats a value now and then): nobody redraws.
      const same = Object.entries(changes).every(([name, value]) => Object.is(state.props[name], value));
      return same ? state : { props: { ...state.props, ...changes } };
    });
  },
  fileLoaded: () => {
    set({ loaded: true });
  },
  endFile: (end) => {
    set({ loaded: false, lastEnd: end });
  },
  addLog: (line) => {
    set((state) => ({ logTail: [...state.logTail, line].slice(-LOG_TAIL_LIMIT) }));
  },
}));

// ---------------------------------------------------------------------------------------------
// Paths

/**
 * A path for people to read. mpv's `path` and the playlist hold `\\?\C:\…` (and `\\?\UNC\server\…`)
 * for long paths; the prefix is taken off: `\\?\C:\x` → `C:\x`, `\\?\UNC\server\share\x` →
 * `\\server\share\x`. Anything else (a link, an ordinary path) is returned as it is.
 */
export function displayPath(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`;
  if (/^\\\\\?\\[A-Za-z]:(\\|$)/.test(path)) return path.slice('\\\\?\\'.length);
  return path;
}

const LINK = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * The name to show for a path or a link: the last part of a path (without the `\\?\` prefix), the
 * last part of a link's path or else its host. Empty for an empty path.
 */
export function fileName(path: string): string {
  if (LINK.test(path)) {
    try {
      const url = new URL(path);
      const last = url.pathname.split('/').filter((part) => part !== '').at(-1);
      return last === undefined ? url.host : decodeURIComponent(last);
    } catch {
      return path;
    }
  }
  return displayPath(path).split(/[\\/]/).filter((part) => part !== '').at(-1) ?? '';
}

// ---------------------------------------------------------------------------------------------
// Selectors

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A finite number, else `undefined` (mpv's `null` for no value, or a value of another type). */
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Whether the player has nothing open (mpv's `idle-active`). The one source of it: after
 * `end-file` a stale `time-pos` can still arrive, so a missing or old time says nothing.
 */
export const selectIdle = (props: PlayerProps): boolean => props['idle-active'] === true;

/** Paused; also until mpv has said otherwise. */
export const selectPaused = (props: PlayerProps): boolean => props['pause'] !== false;

/** Seconds into the file; 0 when nothing is open (also for a stale `time-pos` after `end-file`). */
export const selectTimePos = (props: PlayerProps): number =>
  selectIdle(props) ? 0 : (finite(props['time-pos']) ?? 0);

/** Seconds; 0 while unknown (a stream may not know it). */
export const selectDuration = (props: PlayerProps): number => finite(props['duration']) ?? 0;

/** Percent of the original volume (100 is unchanged). */
export const selectVolume = (props: PlayerProps): number => finite(props['volume']) ?? 100;

/** Playback speed, 1 for normal. */
export const selectSpeed = (props: PlayerProps): number => {
  const speed = finite(props['speed']);
  return speed !== undefined && speed > 0 ? speed : 1;
};

/**
 * Whether the time is running: a file is loaded (so a stale `time-pos` after `end-file` runs
 * nothing), not paused, not stalled for the network, not seeking, not at the end, and a time to
 * run from. Takes the store's state, not only the props: `usePlayerStore(selectPlaying)`.
 */
export const selectPlaying = ({ props, loaded }: Pick<PlayerState, 'props' | 'loaded'>): boolean =>
  loaded &&
  !selectIdle(props) &&
  props['pause'] === false &&
  props['paused-for-cache'] !== true &&
  props['seeking'] !== true &&
  props['eof-reached'] !== true &&
  finite(props['time-pos']) !== undefined;

/**
 * The lists below are made from a property once: the same array comes back until mpv sends a new
 * one, which keeps them usable as zustand selectors.
 */
function memoized<T>(make: (list: readonly unknown[]) => T[]): (value: unknown) => T[] {
  const none: T[] = [];
  const cache = new WeakMap<readonly unknown[], T[]>();
  return (value) => {
    if (!Array.isArray(value)) return none;
    let made = cache.get(value);
    if (!made) {
      made = make(value);
      cache.set(value, made);
    }
    return made;
  };
}

const tracksOf = memoized<Track>((list) =>
  list.filter(
    (entry): entry is Track =>
      isRecord(entry) && typeof entry['id'] === 'number' && typeof entry['type'] === 'string',
  ),
);

/** The tracks of one kind; the `external-filename` of an external file is made readable. */
function tracksOfKind(kind: TrackKind): (props: PlayerProps) => Track[] {
  const found = new WeakMap<Track[], Track[]>();
  return (props) => {
    const all = tracksOf(props['track-list']);
    let ofKind = found.get(all);
    if (!ofKind) {
      ofKind = all
        .filter((track) => track.type === kind)
        .map((track) => {
          const external = track['external-filename'];
          return typeof external === 'string'
            ? { ...track, 'external-filename': displayPath(external) }
            : track;
        });
      found.set(all, ofKind);
    }
    return ofKind;
  };
}

const trackSelectors: Record<TrackKind, (props: PlayerProps) => Track[]> = {
  audio: tracksOfKind('audio'),
  sub: tracksOfKind('sub'),
  video: tracksOfKind('video'),
};

/** The selector for the tracks of one kind: `selectTracks('sub')(props)`. */
export const selectTracks = (kind: TrackKind): ((props: PlayerProps) => Track[]) =>
  trackSelectors[kind];

/** An entry of the playlist, ready to show. */
export type PlaylistItem = {
  /** Its place in the playlist, the index `PlaylistPlay`, `PlaylistRemove` and `PlaylistMove` take. */
  index: number;
  /** The path (readable) or the link. */
  filename: string;
  /** mpv's title, else the file name. */
  title: string;
  /** The entry that plays now. */
  current: boolean;
};

const playlistOf = memoized<PlaylistItem>((list) =>
  list.flatMap((entry, index) => {
    if (!isRecord(entry) || typeof entry['filename'] !== 'string') return [];
    const { filename, title, current } = entry as PlaylistEntry;
    return [
      {
        index,
        filename: displayPath(filename),
        title: title ? title : fileName(filename),
        current: current === true,
      },
    ];
  }),
);

export const selectPlaylist = (props: PlayerProps): PlaylistItem[] => playlistOf(props['playlist']);

const chaptersOf = memoized<Chapter>((list) =>
  list.flatMap((entry) => {
    if (!isRecord(entry) || finite(entry['time']) === undefined) return [];
    const { title, time } = entry as Chapter;
    return [{ title: typeof title === 'string' ? title : '', time }];
  }),
);

export const selectChapters = (props: PlayerProps): Chapter[] => chaptersOf(props['chapter-list']);

/**
 * What is playing, for a title: mpv's `media-title`, else the name of the current playlist entry
 * (the file name; the host of a link), else empty.
 */
export function selectTitle(props: PlayerProps): string {
  const title = props['media-title'];
  if (typeof title === 'string' && title !== '') return displayPath(title);
  return selectPlaylist(props).find((item) => item.current)?.title ?? '';
}

/**
 * The label for the resolution and the dynamic range: `4K`, `1440p`, `1080p` or `720p` by the
 * video's height, and `HDR` for PQ and HLG, so `4K HDR`. `undefined` for nothing to label.
 */
export function selectVideoBadge(props: PlayerProps): string | undefined {
  const params = props['video-params'];
  if (!isRecord(params)) return undefined;
  const height = finite(params['h']) ?? 0;
  const parts: string[] = [];
  if (height >= 2160) parts.push('4K');
  else if (height >= 1440) parts.push('1440p');
  else if (height >= 1080) parts.push('1080p');
  else if (height >= 720) parts.push('720p');
  if (params['gamma'] === 'pq' || params['gamma'] === 'hlg') parts.push('HDR');
  return parts.length > 0 ? parts.join(' ') : undefined;
}
