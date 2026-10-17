import { invoke } from '@tauri-apps/api/core';
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, expect, test, vi, type MockInstance } from 'vitest';

import type { GlassRect } from '../ipc/types';
import { useUiStore } from '../state/uiStore';
import { MAX_REGIONS } from './regions';
import { useGlassRegion } from './useGlassRegion';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

/** The animation frames asked for and not run yet. */
let frames: FrameRequestCallback[] = [];

/** Runs the frame the browser would run next. */
function runFrame(): void {
  const due = frames;
  frames = [];
  for (const callback of due) callback(performance.now());
}

/** How far every glass element is moved to the right (px). */
let shift = 0;
let measured: MockInstance<() => DOMRect>;

/** Glass element `index` sits at x = 10 + 50 × index, 40 × 30. */
function Panel({ index }: { index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useGlassRegion(ref, 12);
  return <div ref={ref} data-index={index} />;
}

/** What was sent to `glass_set_regions`, each call. */
const sent = (): GlassRect[][] =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === 'glass_set_regions')
    .map(([, args]) => (args as { rects: GlassRect[] }).rects);

const resize = () => {
  window.dispatchEvent(new Event('resize'));
};

beforeEach(() => {
  frames = [];
  shift = 0;
  vi.mocked(invoke).mockClear();
  useUiStore.setState(useUiStore.getInitialState(), true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const index = Number(this.dataset['index'] ?? '-1');
    const left = shift + 10 + index * 50;
    return { left, top: 20, width: 40, height: 30, x: left, y: 20, right: left + 40, bottom: 50 } as DOMRect;
  });
});

afterEach(() => {
  // Unmounted while the frames are still ours, and the last frame run: the shared list is empty
  // again and waits for nothing when the next test starts.
  cleanup();
  runFrame();
  measured.mockRestore();
  vi.unstubAllGlobals();
});

test('glass regions are capped at six and sent once per frame', () => {
  render(
    <>
      {Array.from({ length: 8 }, (_, index) => (
        <Panel key={index} index={index} />
      ))}
    </>,
  );

  // Eight elements registered at once: nothing sent yet, one frame asked for.
  expect(sent()).toEqual([]);
  expect(frames).toHaveLength(1);
  runFrame();
  expect(sent()).toHaveLength(1);
  const [first = []] = sent();
  expect(first).toHaveLength(MAX_REGIONS);
  // The first six that registered, in that order, in CSS px of the window.
  expect(first.map((rect) => rect.x)).toEqual([10, 60, 110, 160, 210, 260]);
  expect(first[0]).toEqual({ x: 10, y: 20, w: 40, h: 30, r: 12, a: 1 });

  // Three resizes within one frame move the glass: one frame, one send, where it is now.
  shift = 5;
  resize();
  resize();
  resize();
  expect(frames).toHaveLength(1);
  expect(sent()).toHaveLength(1);
  runFrame();
  expect(sent()).toHaveLength(2);
  expect(sent()[1]?.map((rect) => rect.x)).toEqual([15, 65, 115, 165, 215, 265]);

  // Measured again with nothing moved: nothing new is sent.
  resize();
  runFrame();
  expect(sent()).toHaveLength(2);
});

test('no glass regions are sent while the glass is off, and they come back with it', () => {
  render(<Panel index={0} />);
  runFrame();
  expect(sent().at(-1)).toHaveLength(1);

  // Rust switched the glass off (reduce transparency, Windows, a failed shader): an empty list.
  act(() => {
    useUiStore.getState().setGlass({ enabled: false, reason: 'user' });
  });
  runFrame();
  expect(sent().at(-1)).toEqual([]);

  act(() => {
    useUiStore.getState().setGlass({ enabled: true, reason: null });
  });
  runFrame();
  expect(sent().at(-1)).toEqual([{ x: 10, y: 20, w: 40, h: 30, r: 12, a: 1 }]);
});

test('an element that goes away takes its region with it', () => {
  const { rerender } = render(
    <>
      <Panel index={0} />
      <Panel index={1} />
    </>,
  );
  runFrame();
  expect(sent().at(-1)).toHaveLength(2);

  rerender(<Panel index={0} />);
  runFrame();
  expect(sent().at(-1)?.map((rect) => rect.x)).toEqual([10]);
});
