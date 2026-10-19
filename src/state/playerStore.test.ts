import { beforeEach, describe, expect, test } from 'vitest';

import stateFixture from '../../src-tauri/tests/fixtures/ipc/player.state.json';
import {
  LOG_TAIL_LIMIT,
  displayPath,
  fileName,
  selectChapters,
  selectDuration,
  selectIdle,
  selectPaused,
  selectPlaying,
  selectPlaylist,
  selectSpeed,
  selectTimePos,
  selectTitle,
  selectTracks,
  selectVideoBadge,
  selectVolume,
  usePlayerStore,
  type PlayerProps,
} from './playerStore';

const store = usePlayerStore;

beforeEach(() => {
  store.setState(store.getInitialState(), true);
});

/** What mpv says once a 4K HDR file with tracks, a playlist and chapters plays (the contract's sample). */
const playing: PlayerProps = stateFixture[0]?.changes ?? {};

describe('the store', () => {
  test('applyChanges merges a batch, newest value of each property', () => {
    store.getState().applySnapshot({ pause: true, 'time-pos': 0, volume: 100 });
    store.getState().applyChanges({ pause: false, 'time-pos': 12.5 });
    store.getState().applyChanges({ 'time-pos': 13 });
    expect(store.getState().props).toEqual({ pause: false, 'time-pos': 13, volume: 100 });
  });

  test('a snapshot keeps what a batch brought before it for properties it does not name', () => {
    store.getState().applyChanges({ 'media-title': 'Duna', pause: true });
    store.getState().applySnapshot({ pause: false });
    expect(store.getState().props).toEqual({ 'media-title': 'Duna', pause: false });
  });

  test('a batch that changes nothing does not replace the props', () => {
    store.getState().applySnapshot({ pause: false, volume: 100 });
    const before = store.getState().props;
    store.getState().applyChanges({ pause: false });
    expect(store.getState().props).toBe(before);
    store.getState().applyChanges({ pause: true });
    expect(store.getState().props).not.toBe(before);
  });

  test('a snapshot of a playing file says it is loaded: the UI missed its file-loaded (Ruling R32)', () => {
    expect(store.getState().loaded).toBe(false);
    store.getState().applySnapshot(playing);
    expect(store.getState().loaded).toBe(true);
  });

  test('a snapshot with a time or a duration but no other is a loaded file too', () => {
    store.getState().applySnapshot({ 'idle-active': false, 'time-pos': null, duration: 90 });
    expect(store.getState().loaded).toBe(true);
    store.getState().applySnapshot({ 'idle-active': false, 'time-pos': 3, duration: null });
    expect(store.getState().loaded).toBe(true);
  });

  test('a snapshot taken before mpv knew a time does not undo a file-loaded heard before it (Ruling R33)', () => {
    // The reply to system_ui_ready can come after player:file-loaded, and be a snapshot taken right
    // after loadfile.
    store.getState().fileLoaded();
    expect(store.getState().loaded).toBe(true);
    store.getState().applySnapshot({ 'idle-active': false, 'time-pos': null, duration: null });
    expect(store.getState().loaded).toBe(true);

    // The same snapshot after the file ended, or of an idle player, still clears it.
    store.getState().endFile({ reason: 'eof', error: null, file: null, continues: false, streamError: null });
    store.getState().applySnapshot({ 'idle-active': false, 'time-pos': null, duration: null });
    expect(store.getState().loaded).toBe(false);
    store.getState().fileLoaded();
    store.getState().applySnapshot({ 'idle-active': true, 'time-pos': null, duration: null });
    expect(store.getState().loaded).toBe(false);
  });

  test('an idle snapshot, or one of a file that is still loading, says nothing is loaded', () => {
    store.getState().fileLoaded();
    store.getState().applySnapshot({ 'idle-active': true, 'time-pos': null, duration: null });
    expect(store.getState().loaded).toBe(false);

    // Open, but mpv has no time and no duration yet, and no file-loaded was heard: the idle
    // snapshot above left nothing loaded, so this starts from false.
    expect(store.getState().loaded).toBe(false);
    store.getState().applySnapshot({ 'idle-active': false, 'time-pos': null, duration: null });
    expect(store.getState().loaded).toBe(false);

    // A stale time of a file that has ended does not count while mpv is idle.
    store.getState().applySnapshot({ 'idle-active': true, 'time-pos': 42, duration: 100 });
    expect(store.getState().loaded).toBe(false);
    store.getState().applySnapshot({ pause: true });
    expect(store.getState().loaded).toBe(false);
  });

  test('a value that is gone arrives as null and is kept as null', () => {
    store.getState().applyChanges({ sid: 2, aid: 1 });
    store.getState().applyChanges({ sid: null });
    expect(store.getState().props).toEqual({ sid: null, aid: 1 });
  });

  test('a loaded file stays loaded until it ends (Ruling R4)', () => {
    expect(store.getState().loaded).toBe(false);
    store.getState().fileLoaded();
    expect(store.getState().loaded).toBe(true);
    store.getState().endFile({ reason: 'eof', error: null, file: null, continues: false, streamError: null });
    expect(store.getState().loaded).toBe(false);
    expect(store.getState().lastEnd).toEqual({ reason: 'eof', error: null, file: null, continues: false, streamError: null });
  });

  test('every end of a file is a new object, also an identical one', () => {
    store.getState().endFile({ reason: 'error', error: 'loading failed', file: null, continues: false, streamError: null });
    const first = store.getState().lastEnd;
    store.getState().endFile({ reason: 'error', error: 'loading failed', file: null, continues: false, streamError: null });
    expect(store.getState().lastEnd).toEqual(first);
    expect(store.getState().lastEnd).not.toBe(first);
  });

  test('a file that loads after an error does not clear the error', () => {
    store.getState().endFile({ reason: 'error', error: 'loading failed', file: null, continues: false, streamError: null });
    store.getState().fileLoaded();
    expect(store.getState().lastEnd).toEqual({ reason: 'error', error: 'loading failed', file: null, continues: false, streamError: null });
    expect(store.getState().loaded).toBe(true);
  });

  test('log tail keeps the last 50 lines', () => {
    expect(LOG_TAIL_LIMIT).toBe(50);
    for (let line = 1; line <= 60; line += 1) {
      store.getState().addLog({ level: 'warn', prefix: 'ffmpeg', text: `#${line}` });
    }
    const tail = store.getState().logTail;
    expect(tail).toHaveLength(50);
    expect(tail[0]?.text).toBe('#11');
    expect(tail[49]?.text).toBe('#60');
  });
});

describe('selectors on an empty state', () => {
  test('nothing is known: paused, no time, normal volume and speed, nothing to list', () => {
    const empty: PlayerProps = {};
    expect(selectPaused(empty)).toBe(true);
    expect(selectTimePos(empty)).toBe(0);
    expect(selectDuration(empty)).toBe(0);
    expect(selectVolume(empty)).toBe(100);
    expect(selectSpeed(empty)).toBe(1);
    expect(selectPlaying({ props: empty, loaded: false })).toBe(false);
    expect(selectIdle(empty)).toBe(false);
    expect(selectTracks('audio')(empty)).toEqual([]);
    expect(selectPlaylist(empty)).toEqual([]);
    expect(selectChapters(empty)).toEqual([]);
    expect(selectTitle(empty)).toBe('');
    expect(selectVideoBadge(empty)).toBeUndefined();
  });

  test('unavailable values are treated as empty', () => {
    const unavailable: PlayerProps = { duration: null, 'time-pos': null, 'media-title': null, volume: null };
    expect(selectDuration(unavailable)).toBe(0);
    expect(selectTimePos(unavailable)).toBe(0);
    expect(selectTitle(unavailable)).toBe('');
    expect(selectVolume(unavailable)).toBe(100);
  });

  test('a speed that is not a positive number is normal speed', () => {
    expect(selectSpeed({ speed: 0 })).toBe(1);
    expect(selectSpeed({ speed: null })).toBe(1);
    expect(selectSpeed({ speed: 1.5 })).toBe(1.5);
  });
});

describe('selectors on a playing file', () => {
  test('numbers and flags', () => {
    expect(selectPaused(playing)).toBe(false);
    expect(selectTimePos(playing)).toBe(12.5);
    expect(selectDuration(playing)).toBe(3600.25);
    expect(selectVolume(playing)).toBe(100);
    expect(selectSpeed(playing)).toBe(1);
    expect(selectPlaying({ props: playing, loaded: true })).toBe(true);
    expect(selectIdle(playing)).toBe(false);
  });

  test('the time does not run while paused, seeking, stalled or at the end', () => {
    const running = (props: PlayerProps) => selectPlaying({ props: { ...playing, ...props }, loaded: true });
    expect(running({ pause: true })).toBe(false);
    expect(running({ seeking: true })).toBe(false);
    expect(running({ 'paused-for-cache': true })).toBe(false);
    expect(running({ 'eof-reached': true })).toBe(false);
    // Nothing to run on from while the file loads: mpv has no time yet.
    expect(running({ 'time-pos': null })).toBe(false);
  });

  test('the time does not run before the file is loaded', () => {
    expect(selectPlaying({ props: playing, loaded: false })).toBe(false);
  });

  test('a time-pos that arrives after endFile does not make the player play', () => {
    store.getState().applyChanges(playing);
    store.getState().fileLoaded();
    expect(selectPlaying(store.getState())).toBe(true);

    store.getState().endFile({ reason: 'eof', error: null, file: null, continues: false, streamError: null });
    // end-file comes first; idle-active only turns true after it, and mpv can still send a time.
    store.getState().applyChanges({ 'time-pos': 42, pause: false });
    expect(selectPlaying(store.getState())).toBe(false);
  });

  test('idle comes from idle-active, and a stale time-pos after end-file shows nothing', () => {
    const afterEnd = { ...playing, 'idle-active': true, 'time-pos': 42 };
    expect(selectIdle(afterEnd)).toBe(true);
    expect(selectTimePos(afterEnd)).toBe(0);
    expect(selectPlaying({ props: afterEnd, loaded: true })).toBe(false);
    // No time-pos is not idle: a file that is still loading has none either.
    expect(selectIdle({ 'idle-active': false, 'time-pos': null })).toBe(false);
  });

  test('tracks by kind', () => {
    expect(selectTracks('audio')(playing).map((track) => track.id)).toEqual([1, 2]);
    expect(selectTracks('sub')(playing).map((track) => track.id)).toEqual([1, 2]);
    expect(selectTracks('video')(playing).map((track) => track.id)).toEqual([1]);
    expect(selectTracks('audio')(playing)[0]).toMatchObject({ lang: 'cs', selected: true });
  });

  test('the external subtitle file is shown without the long-path prefix', () => {
    const external = selectTracks('sub')(playing).find((track) => track.external);
    expect(external?.['external-filename']).toBe('C:\\Videa\\film.cs.srt');
  });

  test('lists are the same array until the property changes', () => {
    const audio = selectTracks('audio')(playing);
    expect(selectTracks('audio')({ ...playing, 'time-pos': 99 })).toBe(audio);
    expect(selectPlaylist({ ...playing, pause: true })).toBe(selectPlaylist(playing));
    expect(selectChapters({ ...playing, pause: true })).toBe(selectChapters(playing));
    expect(selectTracks('audio')({ ...playing, 'track-list': [] })).not.toBe(audio);
    // Nothing at all is one empty array too, so an empty list does not redraw.
    expect(selectTracks('sub')({})).toBe(selectTracks('sub')({}));
    expect(selectPlaylist({})).toBe(selectPlaylist({}));
  });

  test('the playlist has readable paths and a title for each entry', () => {
    expect(selectPlaylist(playing)).toEqual([
      {
        index: 0,
        filename: 'C:\\Videa\\Žluťoučký kůň.mkv',
        title: 'Žluťoučký kůň.mkv',
        current: true,
      },
      { index: 1, filename: 'https://example.com/video/clip.mp4', title: 'Ukázka', current: false },
      {
        index: 2,
        filename: '\\\\server\\share\\Videa\\druhý díl.mkv',
        title: 'druhý díl.mkv',
        current: false,
      },
    ]);
  });

  test('chapters', () => {
    expect(selectChapters(playing)).toEqual([
      { title: 'Úvod', time: 0 },
      { title: 'Hlavní část', time: 300.5 },
    ]);
  });

  test('the title is the media title, else the current playlist entry', () => {
    expect(selectTitle(playing)).toBe('Žluťoučký kůň');
    expect(selectTitle({ ...playing, 'media-title': null })).toBe('Žluťoučký kůň.mkv');
    expect(selectTitle({ ...playing, 'media-title': '' })).toBe('Žluťoučký kůň.mkv');
    expect(selectTitle({ 'media-title': '\\\\?\\C:\\Videa\\a.mkv' })).toBe('C:\\Videa\\a.mkv');
  });

  test('the badge of the contract sample', () => {
    expect(selectVideoBadge(playing)).toBe('4K HDR');
  });
});

describe('video badge', () => {
  test('video badge', () => {
    expect(selectVideoBadge({ 'video-params': { h: 2160, gamma: 'pq' } })).toBe('4K HDR');
    expect(selectVideoBadge({ 'video-params': { h: 1080, gamma: 'bt.1886' } })).toBe('1080p');
  });

  test('HLG is HDR too', () => {
    expect(selectVideoBadge({ 'video-params': { h: 1080, gamma: 'hlg' } })).toBe('1080p HDR');
  });

  test.each([
    [2160, '4K'],
    [4320, '4K'],
    [1440, '1440p'],
    [1080, '1080p'],
    [1079, '720p'],
    [720, '720p'],
  ])('a height of %i is labelled %s', (h, label) => {
    expect(selectVideoBadge({ 'video-params': { h, gamma: 'bt.1886' } })).toBe(label);
  });

  test('there is no badge for a small SDR picture or without parameters', () => {
    expect(selectVideoBadge({ 'video-params': { h: 480, gamma: 'bt.1886' } })).toBeUndefined();
    expect(selectVideoBadge({ 'video-params': { gamma: 'bt.1886' } })).toBeUndefined();
    expect(selectVideoBadge({ 'video-params': null })).toBeUndefined();
    expect(selectVideoBadge({})).toBeUndefined();
  });

  test('a small HDR picture is labelled HDR alone', () => {
    expect(selectVideoBadge({ 'video-params': { h: 480, gamma: 'pq' } })).toBe('HDR');
  });
});

describe('displayPath', () => {
  test('takes the long-path prefix off a drive path', () => {
    expect(displayPath('\\\\?\\C:\\Videa\\film.mkv')).toBe('C:\\Videa\\film.mkv');
    expect(displayPath('\\\\?\\C:')).toBe('C:');
  });

  test('turns a verbatim UNC path into a UNC path', () => {
    expect(displayPath('\\\\?\\UNC\\server\\share\\Videa\\film.mkv')).toBe(
      '\\\\server\\share\\Videa\\film.mkv',
    );
    expect(displayPath('\\\\?\\unc\\server\\share')).toBe('\\\\server\\share');
  });

  test('leaves everything else as it is', () => {
    for (const path of [
      'C:\\Videa\\film.mkv',
      '\\\\server\\share\\film.mkv',
      'https://example.com/a.mp4',
      '/home/user/film.mkv',
      '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\film.mkv',
      '',
    ]) {
      expect(displayPath(path)).toBe(path);
    }
  });
});

describe('fileName', () => {
  test('the last part of a path, with either separator and without the prefix', () => {
    expect(fileName('\\\\?\\C:\\Videa\\Žluťoučký kůň.mkv')).toBe('Žluťoučký kůň.mkv');
    expect(fileName('\\\\?\\UNC\\server\\share\\druhý díl.mkv')).toBe('druhý díl.mkv');
    expect(fileName('C:/Videa/film.mkv')).toBe('film.mkv');
    expect(fileName('film.mkv')).toBe('film.mkv');
    expect(fileName('C:\\Videa\\')).toBe('Videa');
    expect(fileName('')).toBe('');
  });

  test('the last part of a link, else its host', () => {
    expect(fileName('https://example.com/video/clip%20one.mp4?token=1')).toBe('clip one.mp4');
    expect(fileName('https://example.com/')).toBe('example.com');
    expect(fileName('https://example.com:8080')).toBe('example.com:8080');
  });
});
