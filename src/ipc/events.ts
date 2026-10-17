/**
 * One subscription function per event Rust emits to the UI, named after it. Each takes a callback
 * for the payload and resolves with the function that stops listening. Subscribe to everything
 * before calling `systemUiReady` (see `startPlayerBridge`): events that came earlier are lost.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type {
  EmptyPayload,
  EndFile,
  EventTable,
  GlassState,
  LogLine,
  OpenRequest,
  PlayerMessage,
  PlayerStateBatch,
  Settings,
  SystemAppearance,
  ThumbReady,
} from './types';

export type { UnlistenFn };

function on<K extends keyof EventTable>(
  event: K,
  callback: (payload: EventTable[K]) => void,
): Promise<UnlistenFn> {
  return listen<EventTable[K]>(event, (e) => {
    callback(e.payload);
  });
}

/** Properties that changed since the last batch, newest value each (`time-pos` 10 times a second at most). */
export const onPlayerState = (callback: (payload: PlayerStateBatch) => void) =>
  on('player:state', callback);

/** A file finished loading and starts to play. */
export const onFileLoaded = (callback: (payload: EmptyPayload) => void) =>
  on('player:file-loaded', callback);

/** A file stopped, and why. */
export const onEndFile = (callback: (payload: EndFile) => void) => on('player:end-file', callback);

/** A `script-message kaleido <args>` from input.conf or a script. */
export const onMessage = (callback: (payload: PlayerMessage) => void) =>
  on('player:message', callback);

/** A warning or an error from mpv's log. */
export const onLog = (callback: (payload: LogLine) => void) => on('player:log', callback);

/** A new timeline preview can be fetched with `thumbGet`. */
export const onThumb = (callback: (payload: ThumbReady) => void) => on('player:thumb', callback);

/** Rust handed the player sources (the command line, the dialog, a drop, the clipboard). */
export const onOpenRequest = (callback: (payload: OpenRequest) => void) =>
  on('system:open-request', callback);

/** Ctrl+V found no link on the clipboard: offer the paste field. */
export const onPasteEmpty = (callback: (payload: EmptyPayload) => void) =>
  on('system:paste-empty', callback);

/** The glass went on or off. Comes only on a change: ask with `glassState` at start. */
export const onGlassState = (callback: (payload: GlassState) => void) =>
  on('glass:state', callback);

/** Kaleido's settings changed; the payload is all of them. */
export const onSettingsChanged = (callback: (payload: Settings) => void) =>
  on('settings:changed', callback);

/** Windows' transparency effects, high contrast or build changed. Comes only on a change: ask with `systemAppearance` at start. */
export const onSystemAppearanceChanged = (callback: (payload: SystemAppearance) => void) =>
  on('system:appearance-changed', callback);
