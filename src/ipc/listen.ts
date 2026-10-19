/**
 * Listening to an event from a React effect. The subscription functions of `events.ts` resolve
 * later, and React runs an effect twice in development (StrictMode), so stopping has to work
 * before the listener is in place too.
 */

import type { UnlistenFn } from './events';

/**
 * Listens with `on` and returns the function that stops it. Stopping works before the listener is
 * in place too (`on` resolves later; React runs an effect twice in development): the callback
 * hears nothing from then on, and the listener is removed as soon as it exists. `listening` runs
 * once the listener is in place, unless it was stopped by then: the moment to ask Rust for what
 * may have been said before anyone listened.
 */
export function listenTo<T>(
  on: (callback: (payload: T) => void) => Promise<UnlistenFn>,
  callback: (payload: T) => void,
  what: string,
  listening?: () => void,
): () => void {
  let stopped = false;
  let unlisten: UnlistenFn | undefined;
  void on((payload) => {
    if (!stopped) callback(payload);
  }).then(
    (stop) => {
      if (stopped) {
        stop();
        return;
      }
      unlisten = stop;
      listening?.();
    },
    (error: unknown) => {
      console.warn(`cannot listen to ${what}`, error);
    },
  );
  return () => {
    stopped = true;
    unlisten?.();
    unlisten = undefined;
  };
}
