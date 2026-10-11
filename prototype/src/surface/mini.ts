export type Rect = { x: number; y: number; w: number; h: number };

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

export const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t,
  h: a.h + (b.h - a.h) * t,
});

/** Floating 16:9 mini player in the bottom-right corner (spec 8.3). */
export function miniRect(viewW: number, viewH: number, width = 360, margin = 24): Rect {
  const w = Math.min(width, Math.max(160, viewW - 2 * margin));
  const h = Math.round((w * 9) / 16);
  return { x: viewW - w - margin, y: viewH - h - margin, w, h };
}

/** Drives one rectangle animation; UI frame and video surface follow the same values (spec 8.6). */
export function animateRect(
  from: Rect,
  to: Rect,
  ms: number,
  onFrame: (r: Rect) => void,
  now: () => number = () => performance.now(),
  raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
): Promise<void> {
  return new Promise((resolve) => {
    const start = now();
    const step = () => {
      const t = Math.min(1, (now() - start) / ms);
      onFrame(t >= 1 ? to : lerpRect(from, to, easeOutCubic(t)));
      if (t < 1) raf(step);
      else resolve();
    };
    raf(step);
  });
}
