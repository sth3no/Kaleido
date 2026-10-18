/**
 * A number the user sets and mpv reports back a moment later (a delay, the subtitle size). While
 * the report has not come, the control shows (and the next step goes from) the value the user set,
 * so that two quick presses are two steps and not one. The value mpv reports takes over when it is
 * the one that was set, or after a short wait (mpv may have held the value to a limit).
 */

import { useEffect, useState } from 'react';

/** How long the user's value is kept when mpv does not report it, ms. */
export const SETTLE_MS = 500;

/** Two reports this close are the same number (mpv's doubles do not print back exactly). */
const SAME = 0.0005;

export function useSettled(reported: number): readonly [shown: number, set: (value: number) => void] {
  /** The value the user has set and mpv has not reported yet. */
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => {
    if (pending === null) return undefined;
    if (Math.abs(reported - pending) < SAME) {
      setPending(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      setPending(null);
    }, SETTLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [pending, reported]);

  return [pending ?? reported, setPending];
}
