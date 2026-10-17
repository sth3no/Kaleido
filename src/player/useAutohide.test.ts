import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { usePlayerStore } from '../state/playerStore';
import { useUiStore } from '../state/uiStore';
import { AUTOHIDE_MS, leftWindow, useAutohide, useLinger } from './useAutohide';

/** A file that plays. */
function startPlaying() {
  usePlayerStore.setState({
    loaded: true,
    props: { 'idle-active': false, pause: false, 'time-pos': 5, duration: 100 },
  });
}

/** The time that passes, in one go (the timers run inside React's act). */
const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

let lastX = 0;

/** The pointer moves to a new place; `target` is what it is over (anything but the window is in the page). */
const movePointer = (target: EventTarget = window) => {
  act(() => {
    lastX += 7;
    target.dispatchEvent(new PointerEvent('pointermove', { clientX: lastX, clientY: 300, bubbles: true }));
  });
};

/** An island of the shell (`data-island`), with a button in it. */
function addIsland(): { island: HTMLElement; button: HTMLButtonElement } {
  const island = document.createElement('div');
  island.setAttribute('data-island', '');
  const button = document.createElement('button');
  island.append(button);
  document.body.append(island);
  return { island, button };
}

beforeEach(() => {
  vi.useFakeTimers();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  lastX = 0;
});

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.style.cursor = '';
  vi.useRealTimers();
});

test('controls hide after 2500 ms without movement', () => {
  startPlaying();
  const { result } = renderHook(() => useAutohide());
  expect(AUTOHIDE_MS).toBe(2500);
  expect(result.current).toBe(false);

  advance(2499);
  expect(result.current).toBe(false);
  advance(1);
  expect(result.current).toBe(true);
});

test('a move or a key shows them at once and the 2500 ms start again', () => {
  startPlaying();
  const { result } = renderHook(() => useAutohide());
  advance(2500);
  expect(result.current).toBe(true);

  movePointer();
  expect(result.current).toBe(false);
  advance(2499);
  expect(result.current).toBe(false);
  advance(1);
  expect(result.current).toBe(true);

  // A key does the same, whoever stops the event.
  act(() => {
    document.body.addEventListener('keydown', (e) => {
      e.stopPropagation();
    });
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  });
  expect(result.current).toBe(false);
  advance(2500);
  expect(result.current).toBe(true);
});

test('movement keeps them: every move starts the 2500 ms again', () => {
  startPlaying();
  const { result } = renderHook(() => useAutohide());
  for (let move = 0; move < 5; move += 1) {
    advance(2000);
    movePointer();
  }
  expect(result.current).toBe(false);
  advance(2500);
  expect(result.current).toBe(true);
});

test('a move that goes nowhere is no movement', () => {
  startPlaying();
  const { result } = renderHook(() => useAutohide());
  movePointer();
  advance(2000);
  // The browser says the pointer moved, to where it was: no news.
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: lastX, clientY: 300 }));
  });
  advance(500);
  expect(result.current).toBe(true);
});

test('controls stay while a panel is open', () => {
  startPlaying();
  const { result } = renderHook(() => useAutohide());
  act(() => {
    useUiStore.getState().setPanel('quick-settings');
  });
  advance(10_000);
  expect(result.current).toBe(false);

  // The 2500 ms start when the panel closes.
  act(() => {
    useUiStore.getState().setPanel(null);
  });
  advance(2499);
  expect(result.current).toBe(false);
  advance(1);
  expect(result.current).toBe(true);
});

test('an open panel shows controls that were hidden', () => {
  startPlaying();
  const { result } = renderHook(() => useAutohide());
  advance(2500);
  expect(result.current).toBe(true);
  act(() => {
    useUiStore.getState().setPanel('playlist');
  });
  expect(result.current).toBe(false);
});

test('controls stay while the sidebar is open', () => {
  startPlaying();
  const { result } = renderHook(() => useAutohide());
  act(() => {
    useUiStore.getState().setSidebarOpen(true);
  });
  advance(10_000);
  expect(result.current).toBe(false);
});

test('they hide only while the video plays: pausing shows them, resuming starts the 2500 ms', () => {
  startPlaying();
  const { result } = renderHook(() => useAutohide());
  advance(2500);
  expect(result.current).toBe(true);

  act(() => {
    usePlayerStore.getState().applyChanges({ pause: true });
  });
  expect(result.current).toBe(false);
  advance(10_000);
  expect(result.current).toBe(false);

  act(() => {
    usePlayerStore.getState().applyChanges({ pause: false });
  });
  advance(2499);
  expect(result.current).toBe(false);
  advance(1);
  expect(result.current).toBe(true);
});

test('they are not hidden before a file plays', () => {
  const { result } = renderHook(() => useAutohide());
  advance(10_000);
  expect(result.current).toBe(false);
});

describe('the cursor', () => {
  test('cursor hides together with the controls', () => {
    startPlaying();
    const { result } = renderHook(() => useAutohide());
    const root = document.documentElement;
    expect(root.style.cursor).toBe('');
    expect(useUiStore.getState().controlsHidden).toBe(false);

    advance(2500);
    expect(result.current).toBe(true);
    expect(root.style.cursor).toBe('none');
    // The shell's islands hear of it from the store.
    expect(useUiStore.getState().controlsHidden).toBe(true);

    // And it is back with them.
    movePointer();
    expect(result.current).toBe(false);
    expect(root.style.cursor).toBe('');
    expect(useUiStore.getState().controlsHidden).toBe(false);
  });

  test('the cursor and the shell are given back when the player page goes', () => {
    startPlaying();
    const { unmount } = renderHook(() => useAutohide());
    advance(2500);
    expect(document.documentElement.style.cursor).toBe('none');

    unmount();
    expect(document.documentElement.style.cursor).toBe('');
    expect(useUiStore.getState().controlsHidden).toBe(false);
  });
});

describe('what holds them', () => {
  test('they stay while the pointer rests on an island, and go 2500 ms after it leaves', () => {
    startPlaying();
    const { island } = addIsland();
    const { result } = renderHook(() => useAutohide());

    movePointer(island);
    advance(10_000);
    expect(result.current).toBe(false);

    // To the video.
    movePointer();
    advance(2499);
    expect(result.current).toBe(false);
    advance(1);
    expect(result.current).toBe(true);
  });

  test('a pointer that is over an island when the video starts to play holds them', () => {
    const { island } = addIsland();
    const { result } = renderHook(() => useAutohide());
    // Nothing plays yet: the pointer comes to rest on the play button, and then the video starts.
    movePointer(island);
    act(() => {
      startPlaying();
    });
    advance(10_000);
    expect(result.current).toBe(false);
  });

  test('they stay while an island has the focus, and go 2500 ms after it loses it', () => {
    startPlaying();
    const { button } = addIsland();
    const { result } = renderHook(() => useAutohide());

    act(() => {
      button.focus();
    });
    advance(10_000);
    expect(result.current).toBe(false);

    act(() => {
      button.blur();
    });
    advance(2499);
    expect(result.current).toBe(false);
    advance(1);
    expect(result.current).toBe(true);
  });

  test('focus that comes to an island shows it', () => {
    startPlaying();
    const { button } = addIsland();
    const { result } = renderHook(() => useAutohide());
    advance(2500);
    expect(result.current).toBe(true);

    act(() => {
      button.focus();
    });
    expect(result.current).toBe(false);
  });

  test('focus outside the islands holds nothing', () => {
    startPlaying();
    const outside = document.createElement('button');
    document.body.append(outside);
    const { result } = renderHook(() => useAutohide());
    act(() => {
      outside.focus();
    });
    advance(2500);
    expect(result.current).toBe(true);
  });
});

describe('Windows’ own window over the maximise button', () => {
  /** The page hears that the pointer left: at (x, y) of the window. */
  const leave = (x: number, y: number) => {
    act(() => {
      document.documentElement.dispatchEvent(new PointerEvent('pointerleave', { clientX: x, clientY: y }));
    });
  };

  test('a pointer that leaves the page inside the window, onto the overlay, is still over the islands', () => {
    startPlaying();
    const { island } = addIsland();
    const { result } = renderHook(() => useAutohide());
    // On the window buttons, near the top right corner of a 1024 × 768 window.
    movePointer(island);
    // The page sees the pointer go, but it is still in the window: it is on the overlay over ⬜.
    leave(990, 30);

    advance(10_000);
    expect(result.current).toBe(false);

    // When it comes back to the page, anywhere else, the islands are free to go.
    movePointer();
    advance(2500);
    expect(result.current).toBe(true);
  });

  test('a pointer that leaves through the edge of the window frees the islands', () => {
    startPlaying();
    const { island } = addIsland();
    const { result } = renderHook(() => useAutohide());
    movePointer(island);
    leave(1023, 30);

    advance(2499);
    expect(result.current).toBe(false);
    advance(1);
    expect(result.current).toBe(true);
  });

  test('leaving over the top edge frees them as well', () => {
    startPlaying();
    const { island } = addIsland();
    const { result } = renderHook(() => useAutohide());
    movePointer(island);
    leave(500, 0);
    advance(2500);
    expect(result.current).toBe(true);
  });

  test('a leave does not stop the timer: only moves keep the islands', () => {
    startPlaying();
    const { result } = renderHook(() => useAutohide());
    movePointer();
    advance(2000);
    // Not over an island: a leave inside the window is none of the timer's business.
    leave(500, 400);
    advance(500);
    expect(result.current).toBe(true);
  });

  test('leftWindow tells the edge from the inside', () => {
    expect(window.innerWidth).toBeGreaterThan(100);
    expect(leftWindow(500, 400)).toBe(false);
    expect(leftWindow(window.innerWidth - 2, 30)).toBe(false);
    expect(leftWindow(window.innerWidth - 1, 30)).toBe(true);
    expect(leftWindow(window.innerWidth, 30)).toBe(true);
    expect(leftWindow(-1, 30)).toBe(true);
    expect(leftWindow(0, 0)).toBe(true);
    expect(leftWindow(500, window.innerHeight)).toBe(true);
  });
});

describe('useLinger', () => {
  test('keeps something for the time it is given after it is no longer wanted', () => {
    const { result, rerender } = renderHook(({ active }) => useLinger(active, 250), {
      initialProps: { active: true },
    });
    expect(result.current).toBe(true);

    rerender({ active: false });
    expect(result.current).toBe(true);
    advance(249);
    expect(result.current).toBe(true);
    advance(1);
    expect(result.current).toBe(false);
  });

  test('is wanted at once again, and keeps nothing from the time before', () => {
    const { result, rerender } = renderHook(({ active }) => useLinger(active, 250), {
      initialProps: { active: true },
    });
    rerender({ active: false });
    advance(100);
    // Back before it was taken away: it stays.
    rerender({ active: true });
    advance(1000);
    expect(result.current).toBe(true);

    rerender({ active: false });
    advance(249);
    expect(result.current).toBe(true);
    advance(1);
    expect(result.current).toBe(false);
  });
});
