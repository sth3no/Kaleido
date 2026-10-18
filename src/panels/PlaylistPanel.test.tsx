import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';

import { initI18n } from '../i18n';
import { attachVideoInput } from '../input/forward';
import type { PlaylistEntry } from '../ipc/types';
import { usePlayerStore } from '../state/playerStore';
import { useUiStore } from '../state/uiStore';
import PlaylistPanel, { moveTarget } from './PlaylistPanel';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

const FILES: PlaylistEntry[] = [
  { filename: 'C:\\Videa\\a.mkv', current: true },
  { filename: 'C:\\Videa\\b.mkv' },
  { filename: 'C:\\Videa\\c.mkv', title: 'Third' },
];

/** The entry of FILES at `index`. */
const file = (index: number): PlaylistEntry => FILES[index] as PlaylistEntry;

/** Every row is 30 px high, one under the other from the top of the window. */
const ROW_HEIGHT = 30;

const setCapture = vi.fn();
const releaseCapture = vi.fn();
let measured: MockInstance<() => DOMRect>;

beforeAll(() => {
  initI18n('en');
  // jsdom has no pointer capture.
  Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: setCapture });
  Object.defineProperty(Element.prototype, 'releasePointerCapture', {
    configurable: true,
    value: releaseCapture,
  });
});

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  setCapture.mockClear();
  releaseCapture.mockClear();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  // The glass measures on animation frames: none run here.
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const row = this.getAttribute('data-index');
    const box =
      row === null
        ? { left: 0, top: 0, width: 380, height: 200 }
        : { left: 0, top: Number(row) * ROW_HEIGHT, width: 380, height: ROW_HEIGHT };
    return {
      ...box,
      x: box.left,
      y: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
    } as DOMRect;
  });
});

afterEach(() => {
  measured.mockRestore();
  vi.unstubAllGlobals();
});

/** The panel as ControlsIsland draws it: over a button. */
function Host() {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} type="button">
        Anchor
      </button>
      <PlaylistPanel anchor={anchor} />
    </>
  );
}

/** A playlist `files` playing, and the panel open. */
function open(files: PlaylistEntry[] = FILES) {
  usePlayerStore.setState({
    loaded: true,
    props: { 'idle-active': false, pause: false, playlist: files },
  });
  useUiStore.setState({ panel: 'playlist' });
  return render(<Host />);
}

/** mpv sends the playlist anew. */
function playlistIs(files: PlaylistEntry[]) {
  act(() => {
    usePlayerStore.getState().applyChanges({ playlist: files });
  });
}

/** The commands sent to the player, each call. */
const commands = (): Record<string, unknown>[] =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([name]) => name === 'player_command')
    .map(([, args]) => (args as { cmd: Record<string, unknown> }).cmd);

/** What was passed on to mpv. */
const forwarded = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'player_input');

const rows = () => screen.getAllByRole('listitem');
/** The button of an entry that plays it, by its place. */
const playOf = (position: number) => rows()[position]?.querySelector<HTMLElement>('[data-play]') as HTMLElement;
const byName = (text: string) => screen.getByRole('button', { name: text }) as HTMLButtonElement;
const remove = (entry: string) => byName(`Remove ${entry} from the playlist`);
const handle = (position: number) => document.querySelectorAll<HTMLElement>('[data-handle]')[position] as HTMLElement;

const pointerOn = {
  down: (position: number, clientY: number) =>
    fireEvent.pointerDown(handle(position), { button: 0, buttons: 1, pointerId: 1, clientY }),
  move: (position: number, clientY: number) =>
    fireEvent.pointerMove(handle(position), { buttons: 1, pointerId: 1, clientY }),
  up: (position: number, clientY: number) =>
    fireEvent.pointerUp(handle(position), { button: 0, buttons: 0, pointerId: 1, clientY }),
};

describe('the entries', () => {
  test('playlist shows the file name when there is no title', () => {
    open();
    expect(rows().map((row) => row.querySelector('[data-play]')?.textContent)).toEqual([
      'a.mkv',
      'b.mkv',
      'Third',
    ]);
  });

  test('a long path shows without its prefix, and a link by its host', () => {
    open([
      { filename: '\\\\?\\C:\\Videa (2026)\\žluťoučký kůň.mkv', current: true },
      { filename: 'https://example.com/watch?v=abc' },
      { filename: 'https://example.com/watch?v=abc', title: 'A talk' },
    ]);
    expect(rows().map((row) => row.querySelector('[data-play]')?.textContent)).toEqual([
      'žluťoučký kůň.mkv',
      'example.com',
      'A talk',
    ]);
  });

  test('the entry that plays is highlighted, and the header says where it is', () => {
    open();
    expect(byName('a.mkv').getAttribute('aria-current')).toBe('true');
    expect(byName('b.mkv').getAttribute('aria-current')).toBeNull();
    expect(rows()[0]?.getAttribute('data-current')).toBe('true');
    expect(rows()[1]?.getAttribute('data-current')).toBe('false');
    expect(screen.getByRole('heading', { name: 'Playlist' })).toBeTruthy();
    expect(screen.getByText('1 of 3')).toBeTruthy();

    // The next one starts: the highlight and the place move with it.
    playlistIs([{ filename: file(0).filename }, { ...file(1), current: true }, file(2)]);
    expect(byName('b.mkv').getAttribute('aria-current')).toBe('true');
    expect(byName('a.mkv').getAttribute('aria-current')).toBeNull();
    expect(screen.getByText('2 of 3')).toBeTruthy();
  });

  test('a click plays the entry', () => {
    open();
    fireEvent.click(byName('b.mkv'));
    expect(commands()).toEqual([{ type: 'playlistPlay', index: 1 }]);
  });

  test('✕ takes the entry out of the playlist', () => {
    open();
    fireEvent.click(remove('b.mkv'));
    expect(commands()).toEqual([{ type: 'playlistRemove', index: 1 }]);
  });

  test('an empty playlist says so, and the panel keeps the focus', () => {
    open([]);
    expect(screen.getByText('The playlist is empty')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Playlist' }));
  });
});

describe('the keyboard', () => {
  test('the panel opens on the entry that plays, which with its ✕ is what Tab reaches', () => {
    open();
    expect(document.activeElement).toBe(byName('a.mkv'));
    expect(byName('a.mkv').tabIndex).toBe(0);
    expect(remove('a.mkv').tabIndex).toBe(0);
    expect(byName('b.mkv').tabIndex).toBe(-1);
    expect(remove('b.mkv').tabIndex).toBe(-1);

    // Where the focus goes, Tab goes.
    act(() => {
      byName('Third').focus();
    });
    expect(byName('Third').tabIndex).toBe(0);
    expect(remove('Third').tabIndex).toBe(0);
    expect(byName('a.mkv').tabIndex).toBe(-1);
  });

  test('the arrows, Home and End move the focus between the entries and do not reach mpv', () => {
    const detach = attachVideoInput(document.createElement('div'));
    try {
      open();
      const a = byName('a.mkv');
      expect(fireEvent.keyDown(a, { key: 'ArrowDown', code: 'ArrowDown' })).toBe(false);
      expect(document.activeElement).toBe(byName('b.mkv'));
      fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown', code: 'ArrowDown' });
      expect(document.activeElement).toBe(byName('Third'));
      // At the end the arrow is handled all the same, and the focus stays.
      expect(fireEvent.keyDown(byName('Third'), { key: 'ArrowDown', code: 'ArrowDown' })).toBe(false);
      expect(document.activeElement).toBe(byName('Third'));
      fireEvent.keyDown(byName('Third'), { key: 'ArrowUp', code: 'ArrowUp' });
      expect(document.activeElement).toBe(byName('b.mkv'));
      fireEvent.keyDown(byName('b.mkv'), { key: 'Home', code: 'Home' });
      expect(document.activeElement).toBe(a);
      expect(fireEvent.keyDown(a, { key: 'ArrowUp', code: 'ArrowUp' })).toBe(false);
      expect(document.activeElement).toBe(a);
      fireEvent.keyDown(a, { key: 'End', code: 'End' });
      expect(document.activeElement).toBe(byName('Third'));

      // From an entry's ✕ the arrows move between the entries too.
      fireEvent.keyDown(remove('Third'), { key: 'ArrowUp', code: 'ArrowUp' });
      expect(document.activeElement).toBe(byName('b.mkv'));

      // Moving the focus plays nothing and moves nothing.
      expect(commands()).toEqual([]);
      expect(forwarded()).toEqual([]);
    } finally {
      detach();
    }
  });

  test('playlist reorders with Alt+Down', () => {
    const detach = attachVideoInput(document.createElement('div'));
    try {
      open();
      const a = byName('a.mkv');
      expect(document.activeElement).toBe(a);

      const passedOn = fireEvent.keyDown(a, { key: 'ArrowDown', code: 'ArrowDown', altKey: true });

      // Handled: mpv does not get Alt+arrow.
      expect(passedOn).toBe(false);
      expect(forwarded()).toEqual([]);
      expect(commands()).toEqual([{ type: 'playlistMove', from: 0, to: 1 }]);
      // The focus is on the place the entry is moving to ...
      expect(document.activeElement).toBe(playOf(1));

      // ... and when mpv's playlist comes, the entry is there.
      playlistIs([file(1), file(0), file(2)]);
      expect(document.activeElement).toBe(playOf(1));
      expect(document.activeElement?.textContent).toBe('a.mkv');
      expect(document.activeElement?.getAttribute('aria-current')).toBe('true');
      expect(screen.getByText('2 of 3')).toBeTruthy();
    } finally {
      detach();
    }
  });

  test('Alt+Up moves the entry up, and at the ends the key is handled and moves nothing', () => {
    open();
    // Up from the second entry.
    const b = byName('b.mkv');
    act(() => {
      b.focus();
    });
    expect(fireEvent.keyDown(b, { key: 'ArrowUp', code: 'ArrowUp', altKey: true })).toBe(false);
    expect(commands()).toEqual([{ type: 'playlistMove', from: 1, to: 0 }]);
    expect(document.activeElement).toBe(playOf(0));

    // Not past the first or the last place.
    expect(fireEvent.keyDown(playOf(0), { key: 'ArrowUp', code: 'ArrowUp', altKey: true })).toBe(false);
    const last = playOf(2);
    act(() => {
      last.focus();
    });
    expect(fireEvent.keyDown(last, { key: 'ArrowDown', code: 'ArrowDown', altKey: true })).toBe(false);
    expect(commands()).toHaveLength(1);
  });

  test('Alt+arrow works from the ✕ of the entry too', () => {
    open();
    fireEvent.keyDown(remove('b.mkv'), { key: 'ArrowDown', code: 'ArrowDown', altKey: true });
    expect(commands()).toEqual([{ type: 'playlistMove', from: 1, to: 2 }]);
    expect(document.activeElement).toBe(playOf(2));
  });
});

describe('✕ and the focus', () => {
  test('goes to the next entry, which takes the place of the one removed', () => {
    open();
    fireEvent.click(remove('b.mkv'));
    expect(commands()).toEqual([{ type: 'playlistRemove', index: 1 }]);
    expect(document.activeElement).toBe(playOf(1));

    playlistIs([file(0), file(2)]);
    expect(rows()).toHaveLength(2);
    expect(document.activeElement).toBe(playOf(1));
    expect(document.activeElement?.textContent).toBe('Third');
  });

  test('goes to the one before when the last entry is removed', () => {
    open();
    fireEvent.click(remove('Third'));
    expect(commands()).toEqual([{ type: 'playlistRemove', index: 2 }]);
    expect(document.activeElement).toBe(playOf(1));

    playlistIs([file(0), file(1)]);
    expect(rows()).toHaveLength(2);
    expect(document.activeElement).toBe(playOf(1));
    expect(document.activeElement?.textContent).toBe('b.mkv');
  });

  test('goes to the first entry when the first is removed', () => {
    open();
    fireEvent.click(remove('a.mkv'));
    expect(document.activeElement).toBe(playOf(0));
  });

  test('stays in the panel when the only entry is removed', () => {
    open([file(0)]);
    fireEvent.click(remove('a.mkv'));
    expect(commands()).toEqual([{ type: 'playlistRemove', index: 0 }]);
    const dialog = screen.getByRole('dialog', { name: 'Playlist' });
    expect(document.activeElement).toBe(dialog);

    playlistIs([]);
    expect(screen.getByText('The playlist is empty')).toBeTruthy();
    expect(document.activeElement).toBe(dialog);
  });
});

describe('dragging by the grip', () => {
  test('the entry moves down to where it is dropped, with a line to show where', () => {
    open();
    pointerOn.down(0, 15);
    expect(setCapture).toHaveBeenCalledWith(1);
    expect(rows()[0]?.getAttribute('data-dragging')).toBe('true');
    // Still over itself: nothing to show.
    expect(document.querySelector('[data-drop]')).toBeNull();

    // In the upper half of the third row: the gap before it.
    pointerOn.move(0, 70);
    expect(rows()[2]?.getAttribute('data-drop')).toBe('before');
    expect(document.querySelectorAll('[data-drop]')).toHaveLength(1);
    expect(commands()).toEqual([]);

    pointerOn.up(0, 70);
    // The entry ends up at 1: the third place, taken out of the list first, is the second.
    expect(commands()).toEqual([{ type: 'playlistMove', from: 0, to: 1 }]);
    expect(releaseCapture).toHaveBeenCalledWith(1);
    expect(document.querySelector('[data-drop]')).toBeNull();
    expect(rows()[0]?.getAttribute('data-dragging')).toBe('false');
    // The focus stays on the entry that moved.
    expect(document.activeElement).toBe(playOf(1));
  });

  test('the entry moves to the end when it is dropped below the last row', () => {
    open();
    pointerOn.down(0, 15);
    pointerOn.move(0, 85);
    expect(rows()[2]?.getAttribute('data-drop')).toBe('after');
    pointerOn.up(0, 85);
    expect(commands()).toEqual([{ type: 'playlistMove', from: 0, to: 2 }]);
    expect(document.activeElement).toBe(playOf(2));
  });

  test('the entry moves up to where it is dropped', () => {
    open();
    pointerOn.down(2, 75);
    pointerOn.move(2, 5);
    expect(rows()[0]?.getAttribute('data-drop')).toBe('before');
    pointerOn.up(2, 5);
    expect(commands()).toEqual([{ type: 'playlistMove', from: 2, to: 0 }]);
    expect(document.activeElement).toBe(playOf(0));
  });

  test('dropped where it was, an entry does not move and no line is shown', () => {
    open();
    pointerOn.down(1, 45);
    // Just above and just below its own middle: the gaps before and after the entry itself.
    pointerOn.move(1, 44);
    expect(document.querySelector('[data-drop]')).toBeNull();
    pointerOn.move(1, 46);
    expect(document.querySelector('[data-drop]')).toBeNull();
    pointerOn.up(1, 46);
    expect(commands()).toEqual([]);
  });

  test('Esc ends the drag without a move, and does not close the panel', () => {
    open();
    pointerOn.down(0, 15);
    pointerOn.move(0, 70);
    expect(document.querySelector('[data-drop]')).not.toBeNull();

    expect(fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' })).toBe(false);
    expect(document.querySelector('[data-drop]')).toBeNull();
    expect(rows()[0]?.getAttribute('data-dragging')).toBe('false');
    expect(useUiStore.getState().panel).toBe('playlist');
    expect(screen.queryByRole('dialog')).not.toBeNull();

    pointerOn.up(0, 70);
    expect(commands()).toEqual([]);

    // With no drag, Esc closes the panel as usual.
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    expect(useUiStore.getState().panel).toBeNull();
  });

  test('a cancelled pointer, a lost release and a button other than the main one move nothing', () => {
    open();
    pointerOn.down(0, 15);
    fireEvent.pointerCancel(handle(0), { pointerId: 1 });
    pointerOn.move(0, 70);
    pointerOn.up(0, 70);

    // The release was never seen: a move with no button down ends the drag.
    pointerOn.down(0, 15);
    fireEvent.pointerMove(handle(0), { buttons: 0, pointerId: 1, clientY: 70 });
    pointerOn.up(0, 70);

    // The right button does not start one.
    setCapture.mockClear();
    fireEvent.pointerDown(handle(0), { button: 2, buttons: 2, pointerId: 1, clientY: 15 });
    expect(setCapture).not.toHaveBeenCalled();
    expect(rows()[0]?.getAttribute('data-dragging')).toBe('false');

    expect(commands()).toEqual([]);
  });
});

describe('moveTarget', () => {
  test('is the place the entry ends up at when dropped in a gap', () => {
    // Down: the gap before entry 2 is, with entry 0 out of the list, the place 1.
    expect(moveTarget(0, 1)).toBe(0);
    expect(moveTarget(0, 2)).toBe(1);
    expect(moveTarget(0, 3)).toBe(2);
    // Up: the place is the gap's number.
    expect(moveTarget(2, 0)).toBe(0);
    expect(moveTarget(2, 1)).toBe(1);
    // The gaps beside the entry itself are no move.
    expect(moveTarget(2, 2)).toBe(2);
    expect(moveTarget(2, 3)).toBe(2);
  });
});
