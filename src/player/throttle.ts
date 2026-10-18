/**
 * A call that goes at most once per `ms`. The first call goes at once, the ones that follow within
 * the interval are held back and only the newest of them goes when the interval is over (which
 * starts the next interval), so that the end of a movement is never lost.
 *
 * It reads no clock, only a timer, so that a test that moves the timers moves it too.
 */

export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  /** Drops the call that is held back and starts over: the next call goes at once. */
  cancel(): void;
  /** Sends the call that is held back, if there is one, now; the next call goes at once. */
  flush(): void;
}

export function throttle<A extends unknown[]>(
  run: (...args: A) => void,
  ms: number,
): Throttled<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let held: A | null = null;

  const interval = () => {
    if (held === null) {
      timer = undefined;
      return;
    }
    const args = held;
    held = null;
    run(...args);
    timer = setTimeout(interval, ms);
  };

  const throttled = (...args: A): void => {
    if (timer === undefined) {
      run(...args);
      timer = setTimeout(interval, ms);
    } else {
      held = args;
    }
  };

  throttled.cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    held = null;
  };

  throttled.flush = (): void => {
    const args = held;
    throttled.cancel();
    if (args !== null) run(...args);
  };

  return throttled;
}
