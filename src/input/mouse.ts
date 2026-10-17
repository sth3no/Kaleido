export type Point = { x: number; y: number };
export type SurfaceRect = { left: number; top: number; width: number; height: number };
export type WheelKey = 'WHEEL_UP' | 'WHEEL_DOWN' | 'WHEEL_LEFT' | 'WHEEL_RIGHT';

/** CSS client coordinates → mpv window pixels; null outside the video surface. */
export function toSurfacePoint(clientX: number, clientY: number, surface: SurfaceRect, dpr: number): Point | null {
  const x = clientX - surface.left;
  const y = clientY - surface.top;
  if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return null;
  return { x: Math.round(x * dpr), y: Math.round(y * dpr) };
}

const BUTTONS = ['MBTN_LEFT', 'MBTN_MID', 'MBTN_RIGHT', 'MBTN_BACK', 'MBTN_FORWARD'];

export function buttonName(button: number): string | null {
  return BUTTONS[button] ?? null;
}

/** The wheel direction of one event: the axis that moved more, and which way. */
export function wheelKey(deltaX: number, deltaY: number): WheelKey | null {
  if (Math.abs(deltaY) >= Math.abs(deltaX)) {
    if (deltaY < 0) return 'WHEEL_UP';
    if (deltaY > 0) return 'WHEEL_DOWN';
    return null;
  }
  return deltaX < 0 ? 'WHEEL_LEFT' : 'WHEEL_RIGHT';
}
