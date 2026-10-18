import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

import { initI18n } from '../i18n';
import type { InputEvent, Layout, PlayerCommand } from '../ipc/types';
import AppShell from '../shell/AppShell';
import { usePlayerStore } from '../state/playerStore';
import { useUiStore } from '../state/uiStore';
import { miniLayout, miniRect, type MiniLayout } from '../surface/mini';
import { holePath, miniBox } from './MiniPlayer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
const appWindow = vi.hoisted(() => ({
  minimize: vi.fn(() => Promise.resolve()),
  toggleMaximize: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  isMaximized: vi.fn(() => Promise.resolve(false)),
  onResized: vi.fn(() => Promise.resolve(() => undefined)),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => appWindow }));

const PLAYING = {
  'idle-active': false,
  pause: false,
  'time-pos': 12,
  duration: 600,
  'media-title': 'Duna',
  'video-params': { w: 1920, h: 1080, dw: 1920, dh: 1080 },
};

const calls = <T,>(command: string, key: string): T[] =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([name]) => name === command)
    .map(([, args]) => (args as Record<string, T>)[key] as T);

const layouts = () => calls<Layout>('surface_set_layout', 'layout');
const commands = () => calls<PlayerCommand>('player_command', 'cmd');
const inputs = () => calls<InputEvent>('player_input', 'event');

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  // The bridge asks Rust for the state; the answers never come, so the tests' state stays.
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(((command: string) =>
    command === 'system_ui_ready' || command === 'glass_state'
      ? new Promise(() => undefined)
      : Promise.resolve(null)) as unknown as typeof invoke);
  // Windows' animations are off: the mini player comes up in its place at once, with no frames to
  // wait for (the animation is surface/useSurfaceLayout.test.ts's).
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ media: query, matches: query === '(prefers-reduced-motion: reduce)' })),
  );
  // The glass is measured at the next frame; these tests do not look at it.
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The shell with a video playing, on the settings page: the mini player. */
function miniPlayer() {
  usePlayerStore.setState({ loaded: true, props: PLAYING });
  render(<AppShell home={<p>Start</p>} player={<p>Video</p>} settings={<p>Options</p>} />);
  act(() => {
    useUiStore.getState().setPage('settings');
  });
  const frame = document.querySelector<HTMLElement>('[data-mini-frame]');
  const video = document.querySelector<HTMLElement>('[data-mini-video]');
  const hole = document.querySelector<HTMLElement>('[data-mini-hole]');
  if (!frame || !video || !hole) throw new Error('no mini player');
  return { frame, video, hole };
}

test('the mini player shows on another page while a file is open, around the page', () => {
  const { frame } = miniPlayer();
  expect(screen.getByText('Options')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Mini player' })).toBe(frame);
  expect(frame.getAttribute('data-phase')).toBe('mini');
  // The root is transparent; the hole layer paints the page around the video.
  expect(document.documentElement.hasAttribute('data-video')).toBe(true);

  // Without a file there is none, and the page is opaque again.
  act(() => {
    usePlayerStore.setState({ loaded: false, props: { 'idle-active': true } });
  });
  expect(document.querySelector('[data-mini-frame]')).toBeNull();
  expect(document.querySelector('[data-mini-hole]')).toBeNull();
  expect(document.documentElement.hasAttribute('data-video')).toBe(false);
});

test('double-click on the mini video returns to the player', () => {
  const { video } = miniPlayer();

  // One click does nothing.
  fireEvent.click(video);
  expect(useUiStore.getState().page).toBe('settings');
  expect(commands()).toEqual([]);

  fireEvent.doubleClick(video);
  expect(useUiStore.getState().page).toBe('player');
  // mpv saw neither click, so it does not go fullscreen on its double click.
  expect(inputs()).toEqual([]);
  expect(commands()).toEqual([]);
  // And the video has the whole window again.
  expect(layouts().at(-1)).toEqual({ kind: 'full' });
  expect(document.querySelector('[data-mini-frame]')).toBeNull();
});

test('the controls: play or pause, back to the player and stop, with labels and the keyboard', () => {
  miniPlayer();
  const controls = screen.getByRole('group', { name: 'Playback controls' });
  expect(controls.className).toMatch(/glass/);

  const pause = screen.getByRole('button', { name: 'Pause' });
  fireEvent.click(pause);
  expect(commands()).toEqual([{ type: 'togglePause' }]);
  act(() => {
    usePlayerStore.setState({ props: { ...PLAYING, pause: true } });
  });
  expect(screen.getByRole('button', { name: 'Play' })).toBe(pause);

  // Reached with Tab like any button; a click with the pointer gives the focus back, so that Space
  // goes to mpv again.
  const stop = screen.getByRole('button', { name: 'Stop' });
  expect(stop.tabIndex).toBe(0);
  stop.focus();
  fireEvent.pointerUp(stop);
  expect(document.activeElement).not.toBe(stop);
  fireEvent.click(stop);
  expect(commands().at(-1)).toEqual({ type: 'stop' });

  fireEvent.click(screen.getByRole('button', { name: 'Back to player' }));
  expect(useUiStore.getState().page).toBe('player');
});

test('the transparent hole is where Rust puts the mini player, also under the UI scale', () => {
  // A UI scale of 125 % and the default glass radius of 20 px on the root.
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) =>
    element === document.documentElement
      ? ({
          getPropertyValue: (name: string) =>
            name === 'zoom' ? '1.25' : name === '--k-radius-l' ? '20px' : '',
        } as CSSStyleDeclaration)
      : real(element, pseudo),
  );
  const { frame, hole } = miniPlayer();

  // What Rust got: the mini player in px of the window, at the UI scale.
  const layout = layouts().at(-1) as MiniLayout;
  expect(layout).toEqual(miniLayout(16 / 9, 1.25));
  const rect = miniRect(layout, window.innerWidth, window.innerHeight);
  if (!rect) throw new Error('no room');

  // The frame in its own px, which the zoom makes px of the window: Rust's rectangle.
  const own = (value: string) => Number.parseFloat(value) * 1.25;
  expect(own(frame.style.left)).toBeCloseTo(rect.x, 1);
  expect(own(frame.style.top)).toBeCloseTo(rect.y, 1);
  expect(own(frame.style.width)).toBeCloseTo(rect.w, 1);
  expect(own(frame.style.height)).toBeCloseTo(rect.h, 1);

  // And the hole is cut out of the page by the same box, with the frame's corners.
  const box = miniBox(rect, { zoom: 1.25, rectsInWindowPx: true }, 20);
  expect(box.r).toBe(20);
  expect(frame.style.borderRadius).toBe('20px');
  expect(hole.style.getPropertyValue('--mini-hole')).toBe(holePath(box));
  expect(holePath(box)).toContain(`M${box.x + 20} ${box.y}H${box.x + box.w - 20}`);
});

test('the video layer passes no pointer to mpv while the video is the mini player', () => {
  miniPlayer();
  const layer = document.querySelector<HTMLElement>('[data-video-layer]');
  if (!layer) throw new Error('no video layer');
  layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1024, height: 768 }) as DOMRect;
  layer.setPointerCapture = vi.fn();
  const press = () => {
    fireEvent.pointerMove(layer, { pointerId: 1, clientX: 900, clientY: 700 });
    fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: 900, clientY: 700 });
    fireEvent.pointerUp(layer, { pointerId: 1, button: 0, clientX: 900, clientY: 700 });
    fireEvent.wheel(layer, { deltaY: 100, deltaMode: 0 });
  };

  expect(layer.getAttribute('data-pointer')).toBe('false');
  press();
  expect(inputs()).toEqual([]);
  // The keyboard still goes to mpv.
  fireEvent.keyDown(document.body, { key: 'ArrowRight', code: 'ArrowRight' });
  expect(inputs()).toEqual([{ type: 'keyDown', key: 'RIGHT' }]);

  // Back in the player, the pointer is mpv's again.
  act(() => {
    useUiStore.getState().setPage('player');
  });
  expect(layer.getAttribute('data-pointer')).toBe('true');
  press();
  expect(inputs()).toContainEqual({ type: 'buttonDown', button: 'MBTN_LEFT' });
});
