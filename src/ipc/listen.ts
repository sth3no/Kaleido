/**
 * Listening to an event from a React effect. The subscription functions of `events.ts` resolve
 * later, and React runs an effect twice in development (StrictMode), so stopping has to work
 * before the listener is in place too.
 */

import type { UnlistenFn } from './events';

/**
 * Listens with `on` and returns the function that stops it. Stopping works before the listener is
 * in place too (`on` resolves later; React runs an effect twice in development): the callback
 * hears nothing from then on, and the listener is removed as soon as it exists.
 */
export function listenTo<T>(
  on: (callback: (payload: T) => void) => Promise<UnlistenFn>,
  callback: (payload: T) => void,
  what: string,
): () => void {
  let stopped = false;
  let unlisten: UnlistenFn | undefined;
  void on((payload) => {
    if (!stopped) callback(payload);
  }).then(
    (stop) => {
      if (stopped) stop();
      else unlisten = stop;
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
