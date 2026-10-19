import { invoke } from '@tauri-apps/api/core';
import i18next from 'i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n } from '../i18n';
import type { StreamFormat, StreamFormats, StreamInfo } from '../ipc/types';
import { usePlayerStore } from '../state/playerStore';
import { heightSelector, qualityOptions, type QualityOption } from './quality';
import { followStreamPath, selectStreamUrl, useStreamStore } from './streamStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const LINK = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const OTHER = 'https://www.twitch.tv/kaleido';
const P720 = heightSelector(720);
const P1080 = heightSelector(1080);

const picture = (height: number): StreamFormat => ({
  formatId: String(height),
  ext: 'mp4',
  height,
  width: Math.round((height * 16) / 9),
  fps: 30,
  vcodec: 'avc1',
  acodec: null,
  dynamicRange: 'SDR',
  tbr: null,
  filesize: null,
  filesizeApprox: null,
  protocol: 'https',
});

const INFO: StreamInfo = {
  title: 'Big Buck Bunny',
  duration: 634.5,
  live: false,
  formats: [picture(720), picture(1080)],
};

const ready = (url: string, chosen: string | null = null): StreamFormats => ({
  url,
  state: { type: 'ready', info: INFO },
  chosen,
});

const loading = (url: string): StreamFormats => ({ url, state: { type: 'loading' }, chosen: null });

/** The choice with `selector`, as the list makes it. */
function option(selector: string | null): QualityOption {
  const found = qualityOptions(INFO, i18next.getFixedT('en')).find(
    (candidate) => candidate.selector === selector,
  );
  if (!found) throw new Error(`no option for ${String(selector)}`);
  return found;
}

/** A promise the test settles when it likes. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type Answers = Record<string, (args: unknown) => unknown>;

function rust(answers: Answers) {
  vi.mocked(invoke).mockImplementation((async (command: string, args?: unknown) =>
    answers[command]?.(args) ?? null) as unknown as typeof invoke);
}

const sent = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

const store = useStreamStore;

/** Lets everything that waits on a promise run. */
const settle = () =>
  new Promise<void>((done) => {
    setTimeout(done, 0);
  });

/** mpv reports a new `path`. */
const play = (path: string | null) => {
  usePlayerStore.getState().applyChanges({ path });
};

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  store.setState(store.getInitialState(), true);
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  vi.mocked(invoke).mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('selectStreamUrl', () => {
  test.each([
    ['http://example.com/a.mp4', 'http://example.com/a.mp4'],
    [LINK, LINK],
    ['HTTPS://EXAMPLE.COM/A', 'HTTPS://EXAMPLE.COM/A'],
    ['HtTp://example.com', 'HtTp://example.com'],
    ['C:\\Videa\\a.mkv', null],
    ['\\\\?\\C:\\Videa\\a.mkv', null],
    ['file:///C:/Videa/a.mkv', null],
    ['ftp://example.com/a.mkv', null],
    ['httpx://example.com', null],
    ['http:/example.com', null],
    ['see http://example.com', null],
    ['', null],
    [null, null],
    [undefined, null],
    [42, null],
  ])('the path %j is a link: %j', (path, expected) => {
    expect(selectStreamUrl({ path })).toBe(expected);
  });

  test('no path at all is no link', () => {
    expect(selectStreamUrl({})).toBeNull();
  });
});

describe('following stream:formats', () => {
  test('what Rust says of the link that plays is kept', () => {
    play(LINK);
    store.getState().apply(loading(LINK));
    expect(store.getState().formats).toEqual(loading(LINK));

    store.getState().apply(ready(LINK, P720));
    expect(store.getState().formats).toEqual(ready(LINK, P720));
  });

  test('an event for another link is ignored', () => {
    play(LINK);
    store.getState().apply(ready(LINK));
    store.getState().apply(ready(OTHER, P720));
    store.getState().apply(loading('https://example.com/other'));
    expect(store.getState().formats).toEqual(ready(LINK));
  });

  test('nothing is kept for what is no link, or while nothing plays', () => {
    store.getState().apply(ready(LINK));
    expect(store.getState().formats).toBeNull();

    play('C:\\Videa\\a.mkv');
    store.getState().apply(ready('C:\\Videa\\a.mkv'));
    expect(store.getState().formats).toBeNull();

    play(null);
    store.getState().apply(ready(LINK));
    expect(store.getState().formats).toBeNull();
  });
});

describe('asking when the path changes', () => {
  test('a path that becomes a link is asked for, and the answer is kept', async () => {
    rust({ stream_formats: () => ready(LINK) });
    const stop = followStreamPath();

    play(LINK);
    await vi.waitFor(() => {
      expect(store.getState().formats).toEqual(ready(LINK));
    });
    expect(sent('stream_formats')).toHaveLength(1);
    stop();
  });

  test('an event that came before the UI knew the path is not lost: the answer has it', async () => {
    rust({ stream_formats: () => ready(LINK, P1080) });
    const stop = followStreamPath();

    // `stream:formats` is early: mpv's path has not reached the UI yet.
    store.getState().apply(loading(LINK));
    expect(store.getState().formats).toBeNull();

    play(LINK);
    await vi.waitFor(() => {
      expect(store.getState().formats).toEqual(ready(LINK, P1080));
    });
    stop();
  });

  test('a file, or nothing, is not asked for', () => {
    rust({});
    const stop = followStreamPath();
    play('C:\\Videa\\a.mkv');
    play(null);
    play('ftp://example.com/a.mkv');
    expect(sent('stream_formats')).toEqual([]);
    stop();
  });

  test('only a change of the path asks, and each link is asked for once', async () => {
    rust({ stream_formats: () => null });
    const stop = followStreamPath();

    play(LINK);
    usePlayerStore.getState().applyChanges({ 'time-pos': 5, pause: false });
    usePlayerStore.getState().applyChanges({ path: LINK });
    expect(sent('stream_formats')).toHaveLength(1);

    play(OTHER);
    expect(sent('stream_formats')).toHaveLength(2);
    await settle();
    stop();
  });

  test('a link that plays when the UI starts is asked for at once', async () => {
    usePlayerStore.getState().applyChanges({ path: LINK });
    rust({ stream_formats: () => ready(LINK, P720) });

    const stop = followStreamPath();
    await vi.waitFor(() => {
      expect(store.getState().formats).toEqual(ready(LINK, P720));
    });
    stop();
  });

  test('stopping stops asking', () => {
    rust({});
    const stop = followStreamPath();
    stop();
    play(LINK);
    expect(sent('stream_formats')).toEqual([]);
  });

  test('an event that came while Rust was asked is newer than its answer', async () => {
    const answer = deferred<StreamFormats>();
    rust({ stream_formats: () => answer.promise });
    const stop = followStreamPath();

    play(LINK);
    await vi.waitFor(() => {
      expect(sent('stream_formats')).toHaveLength(1);
    });
    store.getState().apply(ready(LINK, P720));
    answer.resolve(ready(LINK));
    await settle();

    expect(store.getState().formats).toEqual(ready(LINK, P720));
    stop();
  });

  test('an answer for a link that no longer plays is dropped', async () => {
    const answer = deferred<StreamFormats>();
    rust({ stream_formats: () => answer.promise });
    const stop = followStreamPath();

    play(LINK);
    await vi.waitFor(() => {
      expect(sent('stream_formats')).toHaveLength(1);
    });
    play('C:\\Videa\\a.mkv');
    answer.resolve(ready(LINK));
    await settle();

    expect(store.getState().formats).toBeNull();
    stop();
  });

  test('a read that fails is only reported', async () => {
    rust({
      stream_formats: () => {
        throw new Error('no streams');
      },
    });
    const stop = followStreamPath();
    play(LINK);
    await vi.waitFor(() => {
      expect(console.warn).toHaveBeenCalledWith('stream_formats', expect.any(Error));
    });
    expect(store.getState().formats).toBeNull();
    stop();
  });

  test('an answer that is no state of a link is not taken', async () => {
    rust({ stream_formats: () => 'nothing' });
    const stop = followStreamPath();
    play(LINK);
    await vi.waitFor(() => {
      expect(sent('stream_formats')).toHaveLength(1);
    });
    await settle();
    expect(store.getState().formats).toBeNull();
    stop();
  });
});

describe('the formats of the links that played', () => {
  test('the path passing through nothing, as it does while a quality loads, keeps the formats', () => {
    rust({});
    const stop = followStreamPath();
    play(LINK);
    store.getState().apply(ready(LINK, P720));

    play(null);
    expect(store.getState().formats).toEqual(ready(LINK, P720));
    play(LINK);
    expect(store.getState().formats).toEqual(ready(LINK, P720));
    stop();
  });

  test('another link drops them, and a file in between does not', () => {
    rust({});
    const stop = followStreamPath();
    play(LINK);
    store.getState().apply(ready(LINK, P720));

    play('C:\\Videa\\a.mkv');
    expect(store.getState().formats).toEqual(ready(LINK, P720));
    play(OTHER);
    expect(store.getState().formats).toBeNull();
    stop();
  });
});

describe('choosing a quality', () => {
  test('choosing a height sends its selector and marks it chosen', async () => {
    rust({ player_set_quality: () => null });
    play(LINK);
    store.getState().apply(ready(LINK));

    expect(await store.getState().select(option(P1080))).toBe(true);
    expect(sent('player_set_quality')).toEqual([['player_set_quality', { format: P1080 }]]);

    // What is marked is Rust's word, not the click.
    expect(store.getState().formats?.chosen).toBeNull();
    store.getState().apply(ready(LINK, P1080));
    expect(store.getState().formats?.chosen).toBe(P1080);
  });

  test('Automatic sends nothing but null: the default quality', async () => {
    rust({ player_set_quality: () => null });
    play(LINK);
    store.getState().apply(ready(LINK, P720));

    expect(await store.getState().select(option(null))).toBe(true);
    expect(sent('player_set_quality')).toEqual([['player_set_quality', { format: null }]]);
  });

  test('the choice is at work for the round trip of the command, and no longer', async () => {
    const answer = deferred<null>();
    rust({ player_set_quality: () => answer.promise });
    play(LINK);
    store.getState().apply(ready(LINK));
    expect(store.getState().pending).toBeNull();

    const choosing = store.getState().select(option(P720));
    expect(store.getState().pending).toEqual({ url: LINK, selector: P720 });
    // What Rust says of the link meanwhile does not end it: only the command's answer does.
    store.getState().apply(ready(LINK, P720));
    expect(store.getState().pending).toEqual({ url: LINK, selector: P720 });

    answer.resolve(null);
    expect(await choosing).toBe(true);
    expect(store.getState().pending).toBeNull();
    expect(store.getState().refused).toBeNull();
  });

  test('Automatic is at work for the round trip too', async () => {
    const answer = deferred<null>();
    rust({ player_set_quality: () => answer.promise });
    play(LINK);
    store.getState().apply(ready(LINK, P720));

    const choosing = store.getState().select(option(null));
    expect(store.getState().pending).toEqual({ url: LINK, selector: null });
    answer.resolve(null);
    await choosing;
    expect(store.getState().pending).toBeNull();
  });

  test('a second choice during the round trip takes the first one’s place', async () => {
    const first = deferred<null>();
    const second = deferred<null>();
    let calls = 0;
    rust({
      player_set_quality: () => {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
    });
    play(LINK);
    store.getState().apply(ready(LINK));

    const earlier = store.getState().select(option(P720));
    const later = store.getState().select(option(P1080));
    expect(store.getState().pending).toEqual({ url: LINK, selector: P1080 });

    // The first command returns first: the later choice is still at work.
    first.resolve(null);
    expect(await earlier).toBe(true);
    expect(store.getState().pending).toEqual({ url: LINK, selector: P1080 });

    second.resolve(null);
    expect(await later).toBe(true);
    expect(store.getState().pending).toBeNull();
    expect(sent('player_set_quality')).toHaveLength(2);
  });

  test('a choice Rust refuses is not at work, and is remembered as refused', async () => {
    rust({
      player_set_quality: () => {
        throw 'notAStream';
      },
    });
    play(LINK);
    store.getState().apply(ready(LINK));

    expect(await store.getState().select(option(P720))).toBe(false);
    expect(store.getState().pending).toBeNull();
    expect(store.getState().refused).toEqual({ url: LINK, selector: P720 });
    expect(console.warn).toHaveBeenCalledWith('player_set_quality', 'notAStream');
    // Nothing changed: the quality is whatever Rust said.
    expect(store.getState().formats?.chosen).toBeNull();
  });

  test('the next choice forgets a refusal, and a choice that is taken leaves none', async () => {
    let refuse = true;
    rust({
      player_set_quality: () => {
        if (refuse) throw 'invalid';
        return null;
      },
    });
    play(LINK);
    store.getState().apply(ready(LINK));

    await store.getState().select(option(P720));
    expect(store.getState().refused).toEqual({ url: LINK, selector: P720 });

    refuse = false;
    const choosing = store.getState().select(option(P1080));
    // It is forgotten as soon as the next choice is sent.
    expect(store.getState().refused).toBeNull();
    expect(await choosing).toBe(true);
    expect(store.getState().refused).toBeNull();
  });

  test('the refusal of an earlier choice is not shown when a later one has taken its place', async () => {
    const first = deferred<null>();
    let calls = 0;
    rust({
      player_set_quality: () => {
        calls += 1;
        return calls === 1 ? first.promise : null;
      },
    });
    play(LINK);
    store.getState().apply(ready(LINK));

    const earlier = store.getState().select(option(P720));
    await store.getState().select(option(P1080));
    first.reject('invalid');
    expect(await earlier).toBe(false);

    expect(store.getState().refused).toBeNull();
    expect(store.getState().pending).toBeNull();
  });

  test('what is chosen already, or is being sent, is not chosen again', async () => {
    const answer = deferred<null>();
    let calls = 0;
    rust({
      player_set_quality: () => {
        calls += 1;
        return calls === 1 ? answer.promise : null;
      },
    });
    play(LINK);
    store.getState().apply(ready(LINK, P720));

    expect(await store.getState().select(option(P720))).toBe(false);
    expect(sent('player_set_quality')).toEqual([]);
    expect(store.getState().pending).toBeNull();

    const choosing = store.getState().select(option(P1080));
    expect(await store.getState().select(option(P1080))).toBe(false);
    expect(sent('player_set_quality')).toHaveLength(1);

    // Back to what was chosen before is a choice, while the other is being sent.
    const back = store.getState().select(option(P720));
    expect(sent('player_set_quality')).toHaveLength(2);
    expect(store.getState().pending).toEqual({ url: LINK, selector: P720 });
    answer.resolve(null);
    await Promise.all([choosing, back]);
  });

  test('Automatic is not chosen again either, while it is the quality', async () => {
    rust({ player_set_quality: () => null });
    play(LINK);
    store.getState().apply(ready(LINK, null));

    expect(await store.getState().select(option(null))).toBe(false);
    expect(sent('player_set_quality')).toEqual([]);
  });

  test('nothing is sent while no link plays', async () => {
    rust({ player_set_quality: () => null });
    play('C:\\Videa\\a.mkv');
    expect(await store.getState().select(option(P720))).toBe(false);
    expect(sent('player_set_quality')).toEqual([]);
    expect(store.getState().pending).toBeNull();
  });

  test('another link ends the wait for the one before, and its refusal', async () => {
    const answer = deferred<null>();
    rust({ player_set_quality: () => answer.promise, stream_formats: () => null });
    const stop = followStreamPath();
    play(LINK);
    store.getState().apply(ready(LINK));
    const choosing = store.getState().select(option(P720));
    expect(store.getState().pending).not.toBeNull();

    play(OTHER);
    expect(store.getState().pending).toBeNull();

    // The command returns for a link that no longer plays: it is no refusal of this one.
    answer.reject('notAStream');
    expect(await choosing).toBe(false);
    expect(store.getState().refused).toBeNull();

    store.setState({ refused: { url: OTHER, selector: P720 } });
    play(LINK);
    expect(store.getState().refused).toBeNull();
    stop();
  });
});
