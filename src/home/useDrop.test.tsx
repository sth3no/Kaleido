import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import dropMessageJson from '../../src-tauri/tests/fixtures/drop/message.json';
import { useNoticeStore } from '../state/noticeStore';
import { useUiStore } from '../state/uiStore';
import { DROP_MESSAGE, linkFromDrop, useDrop } from './useDrop';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

/** The hook as the app mounts it, with what it returns on the page. */
function Probe() {
  const dragging = useDrop();
  return <p>{dragging ? 'dragging' : 'idle'}</p>;
}

interface Payload {
  files?: File[];
  /** MIME type → what `getData` answers. */
  data?: Record<string, string>;
  /** The types the drag announces; by default those of `files` and `data`. */
  types?: string[];
}

/** What a drag carries. jsdom has no DataTransfer; the hook reads these members only. */
function transfer({ files = [], data = {}, types }: Payload = {}) {
  return {
    types: types ?? [...(files.length > 0 ? ['Files'] : []), ...Object.keys(data)],
    files,
    getData: (type: string) => data[type] ?? '',
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

const video = () => new File(['x'], 'žluťoučký kůň.mkv', { type: 'video/x-matroska' });

const LINK = 'https://example.com/watch?v=abc';

/** `fireEvent` answers `false` when a listener cancelled the event (`preventDefault`). */
const wasCancelled = (notCancelled: boolean) => !notCancelled;

/** The commands the UI sent to Rust, by name. */
const sent = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(null);
  useUiStore.setState(useUiStore.getInitialState(), true);
  useNoticeStore.setState(useNoticeStore.getInitialState(), true);
});

afterEach(() => {
  delete window.chrome;
  vi.restoreAllMocks();
});

describe('dropping', () => {
  test('dragover is always cancelled, so that WebView2 never navigates to a dropped file', () => {
    render(<Probe />);
    const carried: Payload[] = [
      { files: [video()] },
      { data: { 'text/uri-list': LINK } },
      { data: { 'text/plain': 'some words' } },
      // Nothing Kaleido can open, and nothing at all.
      { data: { 'text/html': '<p>x</p>' } },
      {},
    ];
    for (const payload of carried) {
      expect(wasCancelled(fireEvent.dragOver(window, { dataTransfer: transfer(payload) }))).toBe(true);
    }
  });

  test('the pointer says whether the drag can be dropped here', () => {
    render(<Probe />);
    const openable = transfer({ files: [video()] });
    fireEvent.dragOver(window, { dataTransfer: openable });
    expect(openable.dropEffect).toBe('copy');

    const link = transfer({ data: { 'text/uri-list': LINK } });
    fireEvent.dragOver(window, { dataTransfer: link });
    expect(link.dropEffect).toBe('copy');

    const other = transfer({ data: { 'text/html': '<p>x</p>' } });
    fireEvent.dragOver(window, { dataTransfer: other });
    expect(other.dropEffect).toBe('none');
  });

  test('a dropped link goes to Rust as a pasted one does, through its open queue (Ruling R54)', async () => {
    useUiStore.setState({ page: 'settings' });
    render(<Probe />);

    const notCancelled = fireEvent.drop(window, {
      dataTransfer: transfer({ data: { 'text/uri-list': `${LINK}\r\n`, 'text/plain': LINK } }),
    });

    expect(wasCancelled(notCancelled)).toBe(true);
    // The queue decides: the open-while-playing setting, the playlist of files dropped just before.
    expect(sent('system_open_text')).toEqual([['system_open_text', { text: LINK }]]);
    // Never a load of its own that replaces what plays.
    expect(sent('player_load')).toEqual([]);
    // Rust says when it plays it (`system:open-request`), and the bridge shows the player then;
    // the answer to the command changes no page.
    await Promise.resolve();
    expect(useUiStore.getState().page).toBe('settings');
    // A link that opens has nothing to report.
    expect(useNoticeStore.getState().notices).toEqual([]);
  });

  test('a link that is only text goes to Rust too', () => {
    render(<Probe />);

    fireEvent.drop(window, { dataTransfer: transfer({ data: { 'text/plain': `  ${LINK}\n` } }) });

    expect(sent('system_open_text')).toEqual([['system_open_text', { text: LINK }]]);
  });

  test('a link Rust refuses is logged, shown on a card, and leaves the page as it is', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(invoke).mockRejectedValue({ source: LINK, kind: 'invalid' });
    useUiStore.setState({ page: 'settings' });
    render(<Probe />);

    fireEvent.drop(window, { dataTransfer: transfer({ data: { 'text/uri-list': LINK } }) });

    await waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    expect(useUiStore.getState().page).toBe('settings');
    // And it is said on a card, whichever page the user is on (Ruling R40).
    expect(useNoticeStore.getState().notices.map((notice) => [notice.kind, notice.message])).toEqual([
      ['app', 'errors.dropLink'],
    ]);
  });

  test('a drop that carries no web link plays nothing', () => {
    render(<Probe />);
    const notLinks: Record<string, string>[] = [
      { 'text/plain': 'a few words' },
      { 'text/plain': 'https://example.com/a b' },
      { 'text/plain': 'https://example.com/a\nhttps://example.com/b' },
      { 'text/plain': 'file:///C:/Videa/a.mkv' },
      { 'text/plain': 'javascript:alert(1)' },
      { 'text/uri-list': 'ftp://example.com/a.mkv' },
      { 'text/uri-list': '# only a comment\r\n' },
      { 'text/plain': 'C:\\Videa\\a.mkv' },
      { 'text/html': '<a href="https://example.com">x</a>' },
    ];
    for (const data of notLinks) {
      fireEvent.drop(window, { dataTransfer: transfer({ data }) });
    }
    fireEvent.drop(window, { dataTransfer: transfer() });

    expect(invoke).not.toHaveBeenCalled();
  });

  test('dropping files hands them to WebView2', () => {
    const post = vi.fn();
    window.chrome = { webview: { postMessageWithAdditionalObjects: post } };
    const first = video();
    const second = new File(['y'], 'druhý díl.mp4');
    render(<Probe />);

    const notCancelled = fireEvent.drop(window, { dataTransfer: transfer({ files: [first, second] }) });

    expect(wasCancelled(notCancelled)).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(DROP_MESSAGE, [first, second]);
    // The files go to Rust through WebView2, not through a command: the UI knows no path.
    expect(invoke).not.toHaveBeenCalled();
  });

  test('the drop message is the one Rust reads: a JSON object, never a string', () => {
    const post = vi.fn();
    window.chrome = { webview: { postMessageWithAdditionalObjects: post } };
    render(<Probe />);

    fireEvent.drop(window, { dataTransfer: transfer({ files: [video()] }) });

    // src-tauri/src/system/drop.rs holds its parser to the same file. A string would also reach
    // Tauri's own IPC, which logs an error for every message it cannot parse.
    const [message] = post.mock.calls[0] ?? [];
    expect(typeof message).toBe('object');
    expect(message).toEqual(dropMessageJson);
    expect(DROP_MESSAGE).toEqual(dropMessageJson);
  });

  test('files come before a link that the browser adds to them', () => {
    const post = vi.fn();
    window.chrome = { webview: { postMessageWithAdditionalObjects: post } };
    render(<Probe />);

    fireEvent.drop(window, {
      dataTransfer: transfer({ files: [video()], data: { 'text/uri-list': LINK } }),
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('without WebView2 a drop of files is logged and nothing else happens', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<Probe />);

    const notCancelled = fireEvent.drop(window, { dataTransfer: transfer({ files: [video()] }) });

    expect(wasCancelled(notCancelled)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('a message WebView2 refuses is logged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    window.chrome = {
      webview: {
        postMessageWithAdditionalObjects: () => {
          throw new Error('not a file');
        },
      },
    };
    render(<Probe />);

    expect(() => fireEvent.drop(window, { dataTransfer: transfer({ files: [video()] }) })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('the highlight', () => {
  test('it lasts while something is dragged over the window, over its children too', () => {
    render(<Probe />);
    const files = transfer({ files: [video()] });
    expect(screen.getByText('idle')).toBeTruthy();

    fireEvent.dragEnter(window, { dataTransfer: files });
    expect(screen.getByText('dragging')).toBeTruthy();

    // The pointer moves onto a child: it enters the child before it leaves the parent.
    fireEvent.dragEnter(window, { dataTransfer: files });
    fireEvent.dragLeave(window, { dataTransfer: files });
    expect(screen.getByText('dragging')).toBeTruthy();

    // It leaves the window.
    fireEvent.dragLeave(window, { dataTransfer: files });
    expect(screen.getByText('idle')).toBeTruthy();
  });

  test('a drop ends it', () => {
    // The files have nowhere to go without WebView2; that is logged.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<Probe />);
    const files = transfer({ files: [video()] });
    fireEvent.dragEnter(window, { dataTransfer: files });
    fireEvent.dragEnter(window, { dataTransfer: files });
    expect(screen.getByText('dragging')).toBeTruthy();

    fireEvent.drop(window, { dataTransfer: files });

    expect(screen.getByText('idle')).toBeTruthy();
    // The count started over: one enter and one leave are a whole drag again.
    fireEvent.dragEnter(window, { dataTransfer: files });
    expect(screen.getByText('dragging')).toBeTruthy();
    fireEvent.dragLeave(window, { dataTransfer: files });
    expect(screen.getByText('idle')).toBeTruthy();
  });

  test('a drag of something Kaleido cannot open does not light the zone', () => {
    render(<Probe />);

    fireEvent.dragEnter(window, { dataTransfer: transfer({ data: { 'text/html': '<p>x</p>' } }) });

    expect(screen.getByText('idle')).toBeTruthy();
  });

  test('a link drag lights it as well', () => {
    render(<Probe />);

    fireEvent.dragEnter(window, { dataTransfer: transfer({ data: { 'text/uri-list': LINK } }) });

    expect(screen.getByText('dragging')).toBeTruthy();
  });
});

describe('the listeners', () => {
  test('one drop is handled once, also under StrictMode, which mounts an effect twice', () => {
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );

    fireEvent.drop(window, { dataTransfer: transfer({ data: { 'text/uri-list': LINK } }) });

    expect(sent('system_open_text')).toHaveLength(1);
  });

  test('they are gone once the hook is unmounted', () => {
    const { unmount } = render(<Probe />);
    unmount();

    const notCancelled = fireEvent.drop(window, {
      dataTransfer: transfer({ data: { 'text/uri-list': LINK } }),
    });

    expect(wasCancelled(notCancelled)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('linkFromDrop', () => {
  const dropped = (data: Record<string, string>) => linkFromDrop(transfer({ data }));

  test('takes the first web address of the list, skipping comments and other schemes', () => {
    expect(
      dropped({
        'text/uri-list': `# a comment\r\nftp://example.com/a\r\n${LINK}\r\nhttps://example.com/b`,
      }),
    ).toBe(LINK);
  });

  test('falls back to the text, when that is one address', () => {
    expect(dropped({ 'text/plain': ` ${LINK} ` })).toBe(LINK);
    expect(dropped({ 'text/uri-list': '', 'text/plain': 'http://example.com' })).toBe(
      'http://example.com',
    );
    expect(dropped({ 'text/plain': 'two words' })).toBeNull();
    expect(dropped({})).toBeNull();
  });
});
