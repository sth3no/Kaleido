/**
 * The way Rust's events reach the stores. It listens to every event first and only then calls
 * `system_ui_ready`: that call plays what was opened before the UI was there (a file from the
 * command line) and answers with the player's state, so anything Rust says meanwhile must find a
 * listener. Events a feature handles itself (`player:message`, `player:thumb`,
 * `system:paste-empty`, `settings:changed`) are not Rust's reply to `system_ui_ready`, so their
 * components subscribe when they mount. `stream:formats` is Rust's reply to a link that plays when
 * the UI starts, so it is the bridge's, and so is the watching of `path` that asks for the
 * qualities of a link (`streams/streamStore.ts`).
 */

import { useEffect } from 'react';

import { glassState, systemUiReady } from '../ipc/commands';
import {
  onEndFile,
  onFileLoaded,
  onGlassState,
  onLog,
  onOpenRequest,
  onPlayerState,
  onStreamFormats,
} from '../ipc/events';
import { followStreamPath, useStreamStore } from '../streams/streamStore';
import { usePlayerStore } from './playerStore';
import { useUiStore } from './uiStore';

const warn = (what: string) => (error: unknown) => {
  console.warn(what, error);
};

/**
 * Starts the bridge: subscribes to the events, then asks for the player's state and the glass
 * state, and resolves with the function that stops listening. Aborting `signal` while it starts
 * (React runs an effect twice in development) stops it before it asks for anything, or at the
 * latest before it writes what it got; the function it resolves with is then a no-op.
 */
export async function startPlayerBridge(signal?: AbortSignal): Promise<() => void> {
  const player = () => usePlayerStore.getState();
  const ui = () => useUiStore.getState();
  const streams = () => useStreamStore.getState();
  // A `glass:state` that arrives is newer than the answer to `glass_state`, which is asked for
  // meanwhile.
  let glassEvent = false;
  let released = false;
  // A bridge that was stopped hears nothing, also in the moment before its listeners are gone
  // (React runs an effect twice in development: the first run must not add a line to the log).
  const stopped = () => released || signal?.aborted === true;

  const subscriptions = await Promise.allSettled([
    onPlayerState(({ changes }) => {
      if (!stopped()) player().applyChanges(changes);
    }),
    onFileLoaded(() => {
      if (!stopped()) player().fileLoaded();
    }),
    onEndFile((end) => {
      if (!stopped()) player().endFile(end);
    }),
    onLog((line) => {
      if (!stopped()) player().addLog(line);
    }),
    onGlassState((state) => {
      if (stopped()) return;
      glassEvent = true;
      ui().setGlass(state);
    }),
    // `system_ui_ready` plays what waited for the UI (the file of the command line) and Rust says
    // so with this event while it answers, so it has to be handled here, not by a page that
    // mounts later: the player is the page to show for it.
    onOpenRequest(() => {
      if (!stopped()) ui().setPage('player');
    }),
    // Taken only for the link that plays (the store compares it with `path`); one that comes
    // before the UI knows the path is asked for again when the path arrives.
    onStreamFormats((formats) => {
      if (!stopped()) streams().apply(formats);
    }),
  ]);
  // What stops the watching of `path` (started below, before the first state is asked for).
  let unfollow: (() => void) | undefined;

  const release = () => {
    if (released) return;
    released = true;
    unfollow?.();
    unfollow = undefined;
    for (const subscription of subscriptions) {
      if (subscription.status === 'fulfilled') subscription.value();
    }
  };

  const failed = subscriptions.find(
    (subscription): subscription is PromiseRejectedResult => subscription.status === 'rejected',
  );
  if (failed) {
    release();
    throw failed.reason;
  }
  if (signal?.aborted) {
    release();
    return release;
  }

  // A link that plays when the UI starts arrives as `path` in the first state: watch before it.
  unfollow = followStreamPath();
  await Promise.all([
    systemUiReady().then((snapshot) => {
      if (!signal?.aborted) player().applySnapshot(snapshot);
    }, warn('system_ui_ready')),
    glassState().then((state) => {
      if (!signal?.aborted && !glassEvent) ui().setGlass(state);
    }, warn('glass_state')),
  ]);
  if (signal?.aborted) release();
  return release;
}

/**
 * Runs the bridge for as long as the component is mounted. For the root of the app, once.
 */
export function usePlayerBridge(): void {
  useEffect(() => {
    const abort = new AbortController();
    const started = startPlayerBridge(abort.signal).catch((error: unknown) => {
      console.error('the player bridge did not start', error);
      return () => undefined;
    });
    return () => {
      abort.abort();
      void started.then((stop) => {
        stop();
      });
    };
  }, []);
}
