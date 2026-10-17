/**
 * One function per Tauri command (src-tauri/src/commands.rs), named after it in camelCase. They
 * are thin: the arguments are typed by `CommandTable`, and the promise rejects with what Rust
 * returns as the `Err` (see `CommandErrors`) or, when Tauri cannot run the command at all, with a
 * message. Nothing here waits for mpv on its own; the Rust side decides which commands do.
 */

import { invoke } from '@tauri-apps/api/core';

import type {
  CommandTable,
  DialogPurpose,
  GlassRect,
  InputEvent,
  Layout,
  LoadMode,
  PlayerCommand,
  SettingsPatch,
  ThumbFrame,
} from './types';

/** The arguments of a call: none for a command that takes none, else exactly its arguments. */
type CallArgs<K extends keyof CommandTable> = CommandTable[K]['args'] extends undefined
  ? []
  : [args: CommandTable[K]['args']];

function call<K extends keyof CommandTable>(
  command: K,
  ...args: CallArgs<K>
): Promise<CommandTable[K]['result']> {
  // Without a second argument at all for a command that takes none.
  const [payload] = args as unknown as [Record<string, unknown>?];
  return payload === undefined
    ? invoke<CommandTable[K]['result']>(command)
    : invoke<CommandTable[K]['result']>(command, payload);
}

// --- The player ------------------------------------------------------------------------------

/** Opens files and links. Rejects with the sources that could not be opened (the others open). */
export const playerLoad = (sources: string[], mode: LoadMode) =>
  call('player_load', { sources, mode });

/** Rejects with a message for the log; the UI has nothing to correct. */
export const playerCommand = (cmd: PlayerCommand) => call('player_command', { cmd });

/** Input the UI did not handle (keys, the mouse, the wheel) for mpv; keep the order they came in. */
export const playerInput = (event: InputEvent) => call('player_input', { event });

/**
 * The UI listens to the player's events now: what was opened before plays, and the answer is the
 * player's state (every observed property).
 */
export const systemUiReady = () => call('system_ui_ready');

// --- The video surface and the glass ---------------------------------------------------------

export const surfaceSetLayout = (layout: Layout) => call('surface_set_layout', { layout });

/** The glass elements the UI measured (CSS px); an empty list for no glass. */
export const glassSetRegions = (rects: GlassRect[]) => call('glass_set_regions', { rects });

/** Whether the glass is on: ask when the UI starts, `glass:state` only comes on a change. */
export const glassState = () => call('glass_state');

// --- Timeline previews -----------------------------------------------------------------------

/** Asks for the preview at `seconds`; it arrives as `player:thumb`, then `thumbGet` fetches it. */
export const thumbRequest = (seconds: number) => call('thumb_request', { seconds });

/** The pointer left the seekbar. */
export const thumbClear = () => call('thumb_clear');

/** Bytes in front of the pixels in `thumb_get`: the width and the height, each a little-endian u32. */
const THUMB_HEADER_BYTES = 8;

/**
 * Decodes what `thumb_get` returns: the width and the height as little-endian `u32`, then the RGBA
 * pixels. `null` for the empty answer before the first preview, and for bytes that are not a
 * picture.
 */
export function decodeThumb(bytes: unknown): ThumbFrame | null {
  if (!(bytes instanceof ArrayBuffer)) {
    console.warn('thumb_get did not answer with bytes', bytes);
    return null;
  }
  if (bytes.byteLength < THUMB_HEADER_BYTES) return null;
  const header = new DataView(bytes);
  const width = header.getUint32(0, true);
  const height = header.getUint32(4, true);
  if (bytes.byteLength - THUMB_HEADER_BYTES !== width * height * 4) {
    console.warn('thumb_get: the size does not match the pixels', width, height, bytes.byteLength);
    return null;
  }
  return { width, height, rgba: new Uint8ClampedArray(bytes, THUMB_HEADER_BYTES) };
}

/** The latest preview, `null` before the first. */
export const thumbGet = async (): Promise<ThumbFrame | null> => decodeThumb(await call('thumb_get'));

// --- Opening things --------------------------------------------------------------------------

/** Shows the open dialog and returns at once; what is picked opens from the dialog's thread. */
export const systemOpenDialog = (purpose: DialogPurpose) =>
  call('system_open_dialog', { purpose });

/** Opens the link on the clipboard, or says there is none (`'empty'`: offer the paste field). */
export const systemPaste = () => call('system_paste');

/** Opens the link typed into the paste field. Rejects with a `LoadIssue` when it is no link. */
export const systemOpenText = (text: string) => call('system_open_text', { text });

export const systemOpenRoadmap = () => call('system_open_roadmap');

// --- Settings --------------------------------------------------------------------------------

export const settingsGet = () => call('settings_get');

/**
 * Changes Kaleido's settings with a patch (never the whole settings echoed back); resolves with
 * the new settings. Rejects with a `SettingsError`, and then nothing changed.
 */
export const settingsSet = (patch: SettingsPatch) => call('settings_set', { patch });

/** Every mpv option the settings manage, `null` where there is no value. */
export const settingsGetMpv = () => call('settings_get_mpv');

/** Sets an mpv option from the allow-list; `null` takes it out. Rejects with a `SettingsError`. */
export const settingsSetMpv = (key: string, value: string | null) =>
  call('settings_set_mpv', { key, value });

export const settingsAudioDevices = () => call('settings_audio_devices');

/** The files in the shaders folder that `glsl-shaders` may name. */
export const settingsListShaders = () => call('settings_list_shaders');

/** The installed font families. */
export const systemFonts = () => call('system_fonts');

export const settingsBindings = () => call('settings_bindings');

/** Moves the binding of `key` to `newKey` and silences `key`. Rejects with a `SettingsError`. */
export const settingsRebind = (key: string, newKey: string) =>
  call('settings_rebind', { key, newKey });

/** Puts `key` back to the default it has. Rejects with a `SettingsError`. */
export const settingsResetBinding = (key: string) => call('settings_reset_binding', { key });

// --- System ----------------------------------------------------------------------------------

/** The diagnostics as text for a bug report (no file paths, no URLs). */
export const systemDiagnostics = () => call('system_diagnostics');

/** Puts the diagnostics on the clipboard. Rejects with a message when that fails; say so. */
export const systemCopyDiagnostics = () => call('system_copy_diagnostics');

export const systemOpenLogs = () => call('system_open_logs');

/** The licenses of the third-party software Kaleido ships. */
export const systemLicenses = () => call('system_licenses');
