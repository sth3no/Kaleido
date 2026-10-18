import { beforeEach, describe, expect, test } from 'vitest';

import type { LogLine } from '../ipc/types';
import {
  DETAIL_LINES,
  MAX_NOTICES,
  pushAppNotice,
  useNoticeStore,
  type PlaybackNotice,
} from './noticeStore';

const store = useNoticeStore;

const playback = (name: string, lines: LogLine[] = []) =>
  store.getState().push({
    kind: 'playback',
    message: 'errors.playback.notFound',
    name,
    remedy: 'open',
    error: 'loading failed',
    lines,
  });

const line = (text: string): LogLine => ({ level: 'error', prefix: 'cplayer', text });

beforeEach(() => {
  store.setState(store.getInitialState(), true);
});

describe('the stack', () => {
  test('puts the newest notice on top and gives each one its own id', () => {
    const first = playback('a.mkv');
    const second = playback('b.mkv');

    expect(second).not.toBe(first);
    expect(store.getState().notices.map((notice) => notice.id)).toEqual([second, first]);
  });

  test('keeps at most three: a fourth takes the place of the oldest', () => {
    expect(MAX_NOTICES).toBe(3);
    const ids = ['1', '2', '3', '4'].map((name) => playback(`${name}.mkv`));

    expect(store.getState().notices.map((notice) => notice.id)).toEqual([ids[3], ids[2], ids[1]]);
  });

  test('shows a notice of the app once, with a new timer, however often it comes', () => {
    pushAppNotice('errors.pasteEmpty', 'status');
    const again = store.getState().push({ kind: 'app', message: 'errors.pasteEmpty', tone: 'status' });

    const { notices } = store.getState();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.id).toBe(again);
  });

  test('stacks notices of the app that say different things, and failed files that are alike', () => {
    pushAppNotice('errors.pasteEmpty', 'status');
    pushAppNotice('errors.dropLink');
    playback('a.mkv');
    playback('a.mkv');

    expect(store.getState().notices).toHaveLength(MAX_NOTICES);
    expect(store.getState().notices.filter((notice) => notice.kind === 'playback')).toHaveLength(2);
  });

  test('a notice of the app is an alert unless it says it is a hint', () => {
    pushAppNotice('errors.dropLink');
    pushAppNotice('errors.pasteEmpty', 'status');

    const tones = store.getState().notices.map((notice) => (notice.kind === 'app' ? notice.tone : null));
    expect(tones).toEqual(['status', 'alert']);
  });
});

describe('dismiss', () => {
  test('takes one notice away', () => {
    const first = playback('a.mkv');
    const second = playback('b.mkv');

    store.getState().dismiss(first);

    expect(store.getState().notices.map((notice) => notice.id)).toEqual([second]);
  });

  test('leaves the stack as it is for a notice that is gone (nobody draws again)', () => {
    playback('a.mkv');
    const before = store.getState().notices;

    store.getState().dismiss(9999);

    expect(store.getState().notices).toBe(before);
  });
});

describe('addLogLine', () => {
  const linesOf = (id: number) =>
    (store.getState().notices.find((notice) => notice.id === id) as PlaybackNotice).lines;

  test('adds a line to the end of a failed file', () => {
    const id = playback('a.mkv', [line('first')]);

    store.getState().addLogLine(id, line('second'));

    expect(linesOf(id).map((entry) => entry.text)).toEqual(['first', 'second']);
  });

  test('keeps the newest lines only', () => {
    const id = playback('a.mkv');
    for (let n = 1; n <= DETAIL_LINES + 3; n += 1) store.getState().addLogLine(id, line(`line ${n}`));

    const texts = linesOf(id).map((entry) => entry.text);
    expect(texts).toHaveLength(DETAIL_LINES);
    expect(texts.at(-1)).toBe(`line ${DETAIL_LINES + 3}`);
    expect(texts[0]).toBe('line 4');
  });

  test('does nothing for a notice that is gone, or for one of the app', () => {
    pushAppNotice('errors.dropLink');
    const before = store.getState().notices;

    store.getState().addLogLine(9999, line('x'));
    store.getState().addLogLine(before[0]?.id ?? 0, line('x'));

    expect(store.getState().notices).toBe(before);
  });
});
