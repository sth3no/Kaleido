import { wheelKey, type WheelKey } from './mouse';

/** What the wheel handler needs of a `WheelEvent`. */
export type WheelDelta = { deltaX: number; deltaY: number; deltaMode: number };

/** `steps` whole notches in the direction `key`. */
export type WheelStep = { key: WheelKey; steps: number };

/** Turned further than this in one event, the rest is dropped: a fast spin must not flood mpv
 *  (the same cap as in Rust). */
const MAX_STEPS = 10;

/** Absorbs the rounding of fractional sums (ten times 0.1 is not quite 1). */
const EPSILON = 1e-6;

/** The size of one wheel notch in the unit of `deltaMode` (0 pixels, 1 lines, 2 pages). */
function notch(deltaMode: number): number {
  switch (deltaMode) {
    case 1:
      return 3;
    case 2:
      return 1;
    default:
      return 100;
  }
}

/**
 * Adds up the small steps of a touchpad or a smooth wheel, so that mpv gets a step only once the
 * wheel has turned a whole notch (100 px, 3 lines or 1 page). The part of a notch not yet turned
 * is kept for the next event; a change of direction drops it.
 */
export class WheelAccumulator {
  private key: WheelKey | null = null;
  /** How much of the next notch has turned, in notches. */
  private rest = 0;

  push(e: WheelDelta): WheelStep | null {
    const key = wheelKey(e.deltaX, e.deltaY);
    if (!key) return null;
    if (key !== this.key) {
      this.key = key;
      this.rest = 0;
    }
    const delta = key === 'WHEEL_UP' || key === 'WHEEL_DOWN' ? e.deltaY : e.deltaX;
    this.rest += Math.abs(delta) / notch(e.deltaMode);
    const whole = Math.floor(this.rest + EPSILON);
    if (whole < 1) return null;
    this.rest = Math.max(0, this.rest - whole);
    return { key, steps: Math.min(whole, MAX_STEPS) };
  }
}
