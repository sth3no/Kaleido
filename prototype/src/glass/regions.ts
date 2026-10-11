/** Mirrors `glass::GlassRect` in Rust: CSS px in window coordinates, corner radius, opacity. */
export type GlassRect = { x: number; y: number; w: number; h: number; r: number; a: number };

/** Must match `glass::MAX_REGIONS`. */
export const MAX_REGIONS = 6;

type Measurable = { getBoundingClientRect(): { x: number; y: number; width: number; height: number } };
type StyleLike = { borderTopLeftRadius: string; opacity: string };

export function measure(el: Measurable, style: StyleLike): GlassRect | null {
  const box = el.getBoundingClientRect();
  const alpha = Number.parseFloat(style.opacity);
  if (box.width < 1 || box.height < 1 || !(alpha > 0.01)) return null;
  const radius = Math.min(Number.parseFloat(style.borderTopLeftRadius) || 0, box.width / 2, box.height / 2);
  return { x: box.x, y: box.y, w: box.width, h: box.height, r: radius, a: Math.min(1, alpha) };
}

const key = (r: GlassRect) =>
  [r.x, r.y, r.w, r.h, r.r].map((v) => Math.round(v * 2)).join(',') + ':' + Math.round(r.a * 100);

export function sameRects(a: GlassRect[], b: GlassRect[]): boolean {
  return a.length === b.length && a.every((r, i) => key(r) === key(b[i]));
}
