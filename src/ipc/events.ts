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
  PluginErrorEvent,
  PluginsState,
  Settings,
  StreamFormats,
  SystemAppearance,
  ThumbReady,
  ToolStatus,
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

/**
 * The player core was restarted ("Použít" for plugins) and plays on where it was. The new core
 * reports every property in `player:state` itself; nothing has to be asked for.
 */
export const onEngineRestarted = (callback: (payload: EmptyPayload) => void) =>
  on('player:engine-restarted', callback);

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

/** Something inside Kaleido failed (a panic on the mpv event thread); the log says what. */
export const onSystemError = (callback: (payload: EmptyPayload) => void) =>
  on('system:error', callback);

/** The glass went on or off. Comes only on a change: ask with `glassState` at start. */
export const onGlassState = (callback: (payload: GlassState) => void) =>
  on('glass:state', callback);

/** Kaleido's settings changed; the payload is all of them. */
export const onSettingsChanged = (callback: (payload: Settings) => void) =>
  on('settings:changed', callback);

/** Windows' transparency effects, high contrast or build changed. Comes only on a change: ask with `systemAppearance` at start. */
export const onSystemAppearanceChanged = (callback: (payload: SystemAppearance) => void) =>
  on('system:appearance-changed', callback);

/** The plugins changed (a change, Apply starting or done, a plugin's first error); the payload is all of them. */
export const onPluginsChanged = (callback: (payload: PluginsState) => void) =>
  on('plugins:changed', callback);

/** A plugin logged its first error of this run: show the one quiet notice with "Turn off". */
export const onPluginsError = (callback: (payload: PluginErrorEvent) => void) =>
  on('plugins:error', callback);

/** A tool's state changed: a check started, a download began, or how the check ended. Ask with `toolsStatus` at start. */
export const onToolsStatus = (callback: (payload: ToolStatus) => void) => on('tools:status', callback);

/**
 * What is known of a link's qualities changed: its probe started, ended or failed, a quality was
 * chosen, or a known link plays again. Comes for any link: compare `url` with `path`. Ask with
 * `streamFormats` when `path` changes.
 */
export const onStreamFormats = (callback: (payload: StreamFormats) => void) =>
  on('stream:formats', callback);
