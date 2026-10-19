import { beforeEach, describe, expect, test } from 'vitest';

import type { LogLine, StreamError } from '../ipc/types';
import {
  DETAIL_LINES,
  isWorking,
  MAX_NOTICES,
  pushAppNotice,
  pushPluginNotice,
  useNoticeStore,
  type PlaybackNotice,
  type PluginNotice,
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
    stream: null,
    url: null,
    retry: 'idle',
    refusal: null,
    finding: null,
  });

/** A link that failed for a reason Rust knows, as the card stack makes it from `end-file`. */
const link = (url: string, stream: StreamError = 'network') =>
  store.getState().push({
    kind: 'playback',
    message: `errors.stream.${stream}`,
    name: 'example.com',
    remedy: 'open',
    error: 'loading failed',
    lines: [],
    stream,
    url,
    retry: 'idle',
    refusal: null,
    finding: null,
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

describe('the cards of plugins that report errors', () => {
  const pluginCards = () =>
    store.getState().notices.filter((notice): notice is PluginNotice => notice.kind === 'plugin');

  test('a plugin has one card: a second notice for it adds nothing and gives the one that is there', () => {
    pushPluginNotice('thumbfast');
    const [first] = pluginCards();
    const again = store.getState().push({
      kind: 'plugin',
      message: 'errors.plugin.message',
      name: 'thumbfast',
      phase: 'ask',
      problem: null,
    });

    expect(pluginCards()).toHaveLength(1);
    expect(again).toBe(first?.id);
  });

  test('plugins stack, newest on top, and they begin by offering Disable', () => {
    pushPluginNotice('thumbfast');
    pushPluginNotice('reload');

    expect(pluginCards().map((notice) => notice.name)).toEqual(['reload', 'thumbfast']);
    expect(pluginCards().map((notice) => notice.phase)).toEqual(['ask', 'ask']);
    expect(pluginCards()[0]).toMatchObject({ message: 'errors.plugin.message', problem: null });
  });

  test('setPluginPhase moves a card on, and the reason belongs to a failed one only', () => {
    pushPluginNotice('thumbfast');
    const id = pluginCards()[0]?.id ?? 0;

    store.getState().setPluginPhase(id, 'working');
    expect(pluginCards()[0]?.phase).toBe('working');

    store.getState().setPluginPhase(id, 'failed', { code: 'busy', message: '' });
    expect(pluginCards()[0]).toMatchObject({ phase: 'failed', problem: { code: 'busy' } });

    // A reason that comes with another phase is not kept.
    store.getState().setPluginPhase(id, 'off', { code: 'busy', message: '' });
    expect(pluginCards()[0]).toMatchObject({ phase: 'off', problem: null });
  });

  test('setPluginPhase leaves a card that is gone, and the notices of other kinds, alone', () => {
    playback('a.mkv');
    pushAppNotice('errors.dropLink');
    const before = store.getState().notices;

    store.getState().setPluginPhase(9999, 'working');
    store.getState().setPluginPhase(before[0]?.id ?? 0, 'working');
    store.getState().setPluginPhase(before[1]?.id ?? 0, 'working');

    expect(store.getState().notices).toBe(before);
  });

  test('a fourth notice takes the place of the oldest card that is not at work', () => {
    pushPluginNotice('first');
    store.getState().setPluginPhase(pluginCards()[0]?.id ?? 0, 'working');
    pushPluginNotice('second');
    pushPluginNotice('third');

    pushPluginNotice('fourth');

    expect(pluginCards().map((notice) => notice.name)).toEqual(['fourth', 'third', 'first']);
  });

  test('when every card is at work the oldest still goes, so that the stack is never taller than the rule', () => {
    for (const name of ['a', 'b', 'c']) {
      pushPluginNotice(name);
      store.getState().setPluginPhase(pluginCards()[0]?.id ?? 0, 'working');
    }

    pushPluginNotice('d');

    expect(store.getState().notices).toHaveLength(MAX_NOTICES);
    expect(pluginCards()[0]?.name).toBe('d');
  });
});

describe('the cards of links that failed (spec 10.3)', () => {
  const playbackCards = () =>
    store.getState().notices.filter((notice): notice is PlaybackNotice => notice.kind === 'playback');

  test('a file has no class, no link and no action running', () => {
    playback('a.mkv');

    expect(playbackCards()[0]).toMatchObject({ stream: null, url: null, retry: 'idle' });
  });

  test('a link keeps its class and its address for the action of its class', () => {
    link('https://example.com/watch?v=abc', 'outdated');

    expect(playbackCards()[0]).toMatchObject({
      message: 'errors.stream.outdated',
      stream: 'outdated',
      url: 'https://example.com/watch?v=abc',
      retry: 'idle',
    });
  });

  test('the same link failing twice is two cards: a new failure is a new card', () => {
    link('https://example.com/a');
    link('https://example.com/a');

    expect(playbackCards()).toHaveLength(2);
  });

  test('setRetryPhase moves the action of a link on, one card only', () => {
    const first = link('https://example.com/a');
    const second = link('https://example.com/b');

    store.getState().setRetryPhase(first, 'working');
    expect(playbackCards().map((notice) => notice.retry)).toEqual(['idle', 'working']);

    store.getState().setRetryPhase(first, 'refused');
    store.getState().setRetryPhase(second, 'unsaved');
    expect(playbackCards().map((notice) => notice.retry)).toEqual(['unsaved', 'refused']);
  });

  test('setRetryPhase leaves a card that is gone, the notices of other kinds and a same phase alone', () => {
    const id = link('https://example.com/a');
    pushPluginNotice('thumbfast');
    pushAppNotice('errors.dropLink');
    const before = store.getState().notices;

    store.getState().setRetryPhase(9999, 'working');
    store.getState().setRetryPhase(before[0]?.id ?? 0, 'working');
    store.getState().setRetryPhase(before[1]?.id ?? 0, 'working');
    store.getState().setRetryPhase(id, 'idle');

    expect(store.getState().notices).toBe(before);
  });

  test('a link whose action runs is at work, like a plugin being disabled', () => {
    const id = link('https://example.com/a');
    const card = () => store.getState().notices.find((notice) => notice.id === id) as PlaybackNotice;
    expect(isWorking(card())).toBe(false);

    store.getState().setRetryPhase(id, 'working');
    expect(isWorking(card())).toBe(true);

    store.getState().setRetryPhase(id, 'refused');
    expect(isWorking(card())).toBe(false);
  });

  test('a fourth notice does not push out the link whose action runs', () => {
    const first = link('https://example.com/a');
    store.getState().setRetryPhase(first, 'working');
    playback('b.mkv');
    playback('c.mkv');

    playback('d.mkv');

    expect(playbackCards().map((notice) => notice.name)).toEqual(['d.mkv', 'c.mkv', 'example.com']);
    expect(store.getState().notices.some((notice) => notice.id === first)).toBe(true);
  });

  test('a refused link keeps how it was refused, and only a refused one', () => {
    const id = link('https://example.com/a');

    store.getState().setRetryPhase(id, 'refused', { kind: 'protocol', saved: true });
    expect(playbackCards()[0]).toMatchObject({ retry: 'refused', refusal: { kind: 'protocol', saved: true } });

    // Another reason for the same phase is a change.
    store.getState().setRetryPhase(id, 'refused', { kind: null, saved: false });
    expect(playbackCards()[0]?.refusal).toEqual({ kind: null, saved: false });

    // The reason goes with the phase; one that comes with another phase is not kept.
    store.getState().setRetryPhase(id, 'unsaved', { kind: 'invalid', saved: true });
    expect(playbackCards()[0]).toMatchObject({ retry: 'unsaved', refusal: null });
    store.getState().setRetryPhase(id, 'working');
    expect(playbackCards()[0]?.refusal).toBeNull();
  });

  test('the same refusal again leaves the stack as it is', () => {
    const id = link('https://example.com/a');
    const refusal = { kind: 'invalid', saved: false } as const;
    store.getState().setRetryPhase(id, 'refused', refusal);
    const before = store.getState().notices;

    store.getState().setRetryPhase(id, 'refused', refusal);

    expect(store.getState().notices).toBe(before);
  });

  test('an update that found nothing new keeps what it found, until the action runs again', () => {
    const id = link('https://example.com/a', 'outdated');
    const finding = { kind: 'newest', version: '2026.10.10', nightly: false } as const;

    store.getState().setUnchanged(id, finding);
    expect(playbackCards()[0]).toMatchObject({ retry: 'unchanged', refusal: null, finding });
    // Not a card at work: it goes by itself and can be pushed out.
    expect(isWorking(playbackCards()[0] as PlaybackNotice)).toBe(false);

    store.getState().setRetryPhase(id, 'working');
    expect(playbackCards()[0]).toMatchObject({ retry: 'working', finding: null });
    // A card that is gone, or no playback card, is left alone.
    const before = store.getState().notices;
    store.getState().setUnchanged(9999, finding);
    expect(store.getState().notices).toBe(before);
  });
});

describe('a plugin is told once in a session', () => {
  test('a second notice for a plugin adds no card, also after its card has gone', () => {
    pushPluginNotice('thumbfast');
    const [card] = store.getState().notices;
    expect(store.getState().toldPlugins).toEqual(['thumbfast']);

    store.getState().dismiss(card?.id ?? 0);
    pushPluginNotice('thumbfast');

    expect(store.getState().notices).toHaveLength(0);
    // Another plugin is told as before.
    pushPluginNotice('reload');
    expect(store.getState().notices).toHaveLength(1);
    expect(store.getState().toldPlugins).toEqual(['thumbfast', 'reload']);
  });
});

describe('the card the focus is in', () => {
  test('setFocusInside notes the card, and leaving a card that is not the noted one changes nothing', () => {
    const first = playback('a.mkv');
    const second = playback('b.mkv');

    store.getState().setFocusInside(first, true);
    expect(store.getState().focused).toBe(first);

    // The focus has moved on to the other card: its event may come before the first one's leaving.
    store.getState().setFocusInside(second, true);
    store.getState().setFocusInside(first, false);
    expect(store.getState().focused).toBe(second);

    store.getState().setFocusInside(second, false);
    expect(store.getState().focused).toBeNull();
  });

  test('a fourth notice does not push out the card the focus is in', () => {
    const first = playback('a.mkv');
    playback('b.mkv');
    playback('c.mkv');
    store.getState().setFocusInside(first, true);

    playback('d.mkv');

    // The oldest card that has no focus goes instead: b.mkv.
    expect(store.getState().notices.map((notice) => notice.kind === 'playback' && notice.name)).toEqual([
      'd.mkv',
      'c.mkv',
      'a.mkv',
    ]);
  });

  test('the card that is neither at work nor in focus goes, and the other two stay', () => {
    const first = playback('a.mkv');
    store.getState().setRetryPhase(first, 'working');
    const second = playback('b.mkv');
    store.getState().setFocusInside(second, true);
    playback('c.mkv');

    const newest = link('https://example.com/a');

    expect(store.getState().notices).toHaveLength(MAX_NOTICES);
    // c.mkv was the one that was neither.
    expect(store.getState().notices.map((notice) => notice.id)).toEqual([newest, second, first]);
  });

  test('when every card is spared the oldest goes all the same', () => {
    const first = playback('a.mkv');
    store.getState().setRetryPhase(first, 'working');
    const second = playback('b.mkv');
    store.getState().setFocusInside(second, true);
    const third = playback('c.mkv');
    store.getState().setRetryPhase(third, 'working');

    const newest = playback('d.mkv');

    expect(store.getState().notices.map((notice) => notice.id)).toEqual([newest, third, second]);
  });

  test('a card that is dismissed no longer holds the note', () => {
    const id = playback('a.mkv');
    store.getState().setFocusInside(id, true);

    store.getState().dismiss(id);

    expect(store.getState().focused).toBeNull();
  });
});
