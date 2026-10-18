import { describe, expect, test } from 'vitest';

import golden from '../../src-tauri/tests/fixtures/surface/mini_layout.json';
import {
  animateRect,
  DEFAULT_ASPECT,
  easeOutCubic,
  lerpRect,
  MINI,
  miniLayout,
  miniRect,
  videoAspect,
  type FrameClock,
  type Rect,
} from './mini';

// Ported from the M0 prototype (prototype/src/surface/mini.test.ts), with M1's numbers: 360 px
// wide, 16 px from the corner.

describe('mini player geometry', () => {
  test('eases from 0 to 1', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  test('interpolates rectangles', () => {
    expect(lerpRect({ x: 0, y: 0, w: 100, h: 50 }, { x: 100, y: 50, w: 200, h: 150 }, 0.5)).toEqual({
      x: 50,
      y: 25,
      w: 150,
      h: 100,
    });
  });

  test('places a 16:9 mini player bottom-right', () => {
    // 360 / (16 / 9) = 202.5, a whole 203 px.
    expect(miniRect(miniLayout(16 / 9), 1280, 720)).toEqual({ x: 904, y: 501, w: 360, h: 203 });
  });

  test('shrinks the mini player in a narrow window', () => {
    // 16 px on both sides of a 300 px window leave 268.
    const rect = miniRect(miniLayout(16 / 9), 300, 400);
    expect(rect?.w).toBeCloseTo(268);
    expect(rect && rect.w / rect.h).toBeCloseTo(360 / 203);
    expect(rect && rect.x + rect.w).toBeCloseTo(300 - 16);
  });

  test('mini layout uses the video aspect', () => {
    // 4:3 → h = 270.
    expect(miniLayout(4 / 3)).toEqual({ kind: 'mini', w: 360, h: 270, right: 16, bottom: 16 });
    expect(miniLayout(videoAspect({ w: 1440, h: 1080, dw: 1440, dh: 1080 })).h).toBe(270);
    // Without a picture (yet): 16:9.
    expect(miniLayout(videoAspect(null))).toEqual(miniLayout(16 / 9));
    expect(miniLayout(Number.NaN)).toEqual(miniLayout(DEFAULT_ASPECT));
  });

  test('the shape is the display size, turned with the rotation', () => {
    // Anamorphic DVD: 720 × 576 stored, 1024 × 576 shown.
    expect(videoAspect({ w: 720, h: 576, dw: 1024, dh: 576 })).toBeCloseTo(16 / 9);
    expect(videoAspect({ aspect: 2.39 })).toBeCloseTo(2.39);
    expect(videoAspect({ w: 1920, h: 1080 })).toBeCloseTo(16 / 9);
    // A phone video recorded on its side.
    expect(videoAspect({ dw: 1920, dh: 1080, rotate: 90 })).toBeCloseTo(9 / 16);
    expect(videoAspect({ dw: 1920, dh: 1080, rotate: 180 })).toBeCloseTo(16 / 9);
    expect(videoAspect({ dw: 0, dh: 1080 })).toBe(DEFAULT_ASPECT);
  });

  test('a portrait video is as high as the mini player is wide', () => {
    expect(miniLayout(9 / 16)).toEqual({ kind: 'mini', w: 203, h: 360, right: 16, bottom: 16 });
  });

  test('the mini player grows with the UI scale, in px of the window', () => {
    expect(miniLayout(4 / 3, 1.5)).toEqual({
      kind: 'mini',
      w: MINI.w * 1.5,
      h: 270 * 1.5,
      right: MINI.right * 1.5,
      bottom: MINI.bottom * 1.5,
    });
  });

  test('no room is no mini player', () => {
    expect(miniRect(miniLayout(16 / 9), 30, 400)).toBeNull();
    expect(miniRect(miniLayout(16 / 9), 0, 0)).toBeNull();
  });
});

describe('the table the UI and Rust share (Ruling R47)', () => {
  // src-tauri/src/surface/layout.rs tests the same table: Rust places the layout at `placement`.
  test.each(golden.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const { client, scale, aspect, zoom, hole, placement } = entry;
    // What the UI sends.
    const layout = miniLayout(aspect[0] / aspect[1], zoom);
    expect(layout).toEqual(entry.layout);

    // The hole, in a window of the client's size in CSS px (the fraction of a px included).
    const rect = miniRect(layout, client.w / scale, client.h / scale);
    if (!rect) throw new Error('no mini player');
    expect(rect.x).toBeCloseTo(hole.x, 2);
    expect(rect.y).toBeCloseTo(hole.y, 2);
    expect(rect.w).toBeCloseTo(hole.w, 2);
    expect(rect.h).toBeCloseTo(hole.h, 2);

    // mpv's window covers all of it: no seam on any side.
    expect(rect.x * scale).toBeGreaterThanOrEqual(placement.x - 1e-6);
    expect(rect.y * scale).toBeGreaterThanOrEqual(placement.y - 1e-6);
    expect((rect.x + rect.w) * scale).toBeLessThanOrEqual(placement.x + placement.w + 1e-6);
    expect((rect.y + rect.h) * scale).toBeLessThanOrEqual(placement.y + placement.h + 1e-6);
  });

  test('the table has the review’s case and the fractional display scales', () => {
    expect(golden.cases.some(({ client, scale }) => client.w === 1921 && client.h === 1081 && scale === 1.5)).toBe(
      true,
    );
    expect(new Set(golden.cases.map(({ scale }) => scale))).toEqual(new Set([1, 1.25, 1.5, 1.75]));
  });
});

/** A clock whose frames come when the test says, `ms` apart. */
function testClock(ms: number) {
  let time = 0;
  let next = 1;
  const frames = new Map<number, () => void>();
  const clock: FrameClock = {
    now: () => time,
    request: (run) => {
      frames.set(next, run);
      return next++;
    },
    cancel: (id) => {
      frames.delete(id);
    },
  };
  const frame = () => {
    time += ms;
    const due = [...frames.values()];
    frames.clear();
    for (const run of due) run();
  };
  return { clock, frame, pending: () => frames.size };
}

describe('animateRect', () => {
  const to: Rect = { x: 10, y: 10, w: 10, h: 10 };
  const from: Rect = { x: 0, y: 0, w: 0, h: 0 };

  test('reports frames and ends exactly on the target', () => {
    const { clock, frame, pending } = testClock(50);
    const frames: number[] = [];
    let done = 0;
    animateRect(from, to, 200, (r) => frames.push(r.x), () => (done += 1), clock);
    for (let i = 0; i < 6; i += 1) frame();
    expect(frames.length).toBe(4);
    expect(frames.at(-1)).toBe(10);
    expect(done).toBe(1);
    // At rest nothing waits for a frame.
    expect(pending()).toBe(0);
  });

  test('stopped, it reports nothing more and is not done', () => {
    const { clock, frame, pending } = testClock(50);
    const frames: number[] = [];
    let done = 0;
    const stop = animateRect(from, to, 200, (r) => frames.push(r.x), () => (done += 1), clock);
    frame();
    stop();
    frame();
    frame();
    expect(frames).toHaveLength(1);
    expect(done).toBe(0);
    expect(pending()).toBe(0);
  });
});
