/**
 * One function per Tauri command (src-tauri/src/commands.rs), named after it in camelCase. They
 * are thin: the arguments are typed by `CommandTable`, and the promise rejects with what Rust
 * returns as the `Err` (see `CommandErrors`) or, when Tauri cannot run the command at all, with a
 * message. Nothing here waits for mpv on its own; the Rust side decides which commands do.
 */

import { invoke } from '@tauri-apps/api/core';

import type {
  CaptionButton,
  CommandTable,
  DialogPurpose,
  GlassRect,
  InputEvent,
  Layout,
  LoadMode,
  PlayerCommand,
  SettingsPatch,
  SourcePage,
  ThumbFrame,
  ToolId,
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

/**
 * The window buttons Windows hit-tests itself (CSS px of the window): today the maximise/restore
 * button, for Snap Layouts. An empty list while none is shown (hidden controls, fullscreen).
 */
export const surfaceSetCaptionButtons = (rects: CaptionButton[]) =>
  call('surface_set_caption_buttons', { rects });

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

/**
 * Opens a page about the sources of what Kaleido ships in the browser: its releases, or the libmpv
 * build (spec 11.6). Rust has the addresses.
 */
export const systemOpenSource = (which: SourcePage) => call('system_open_source', { which });

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

/**
 * What the UI's error boundary caught (`shell/ErrorBoundary.tsx`), for kaleido.log: the error and
 * its stacks. Rust keeps the first 4 KB, on one line.
 */
export const systemUiError = (message: string) => call('system_ui_error', { message });

/** The licenses of the third-party software Kaleido ships. */
export const systemLicenses = () => call('system_licenses');

/**
 * Windows' transparency effects, high contrast and build. Ask when the UI starts: the event
 * (`onSystemAppearanceChanged`) comes only on a change.
 */
export const systemAppearance = () => call('system_appearance');

/**
 * The system's language as a BCP 47 tag (`cs-CZ`), for the language setting "system"
 * (`resolveLanguage`). `en-US` where Windows names none.
 */
export const systemLocale = () => call('system_locale');

/**
 * The browsers on this PC whose cookies yt-dlp can use, Firefox first, each with the `spec` to save
 * as `playback.cookiesFromBrowser` and a warning where it may not work. Reads the disk.
 */
export const systemBrowsers = () => call('system_browsers');

// --- Plugins ---------------------------------------------------------------------------------
// Every change resolves with the new state and sends it as `plugins:changed` too; it rejects with
// a `PluginError`, and then nothing changed. `name` is always `PluginInfo.name`.

/** The plugins in the config folder, whether each runs, and whether a change waits for Apply. */
export const pluginsList = () => call('plugins_list');

/** Turns a plugin on (one that does not run starts at once) or off (it runs until Apply). */
export const pluginsSetEnabled = (name: string, enabled: boolean) =>
  call('plugins_set_enabled', { name, enabled });

/** Moves a plugin to the Recycle Bin; its settings stay. One that runs, runs until Apply. */
export const pluginsUninstall = (name: string) => call('plugins_uninstall', { name });

/** Installs the removed essentials again (`PluginsState.removedEssentials`). */
export const pluginsRestoreEssentials = () => call('plugins_restore_essentials');

/** A plugin's settings: its schema and what its file sets. */
export const pluginsSettings = (name: string) => call('plugins_settings', { name });

/**
 * Sets a key of a plugin's settings; `null` takes it out (the script's default). Resolves with the
 * settings as they are now; a plugin that runs gets the change at Apply.
 */
export const pluginsSetSetting = (name: string, key: string, value: string | null) =>
  call('plugins_set_setting', { name, key, value });

/** A plugin's last errors of this run, the oldest first. */
export const pluginsLog = (name: string) => call('plugins_log', { name });

/**
 * "Apply": restarts the player core, which plays on where it was, with the plugins that are on.
 * `plugins:changed` says `applying` at the start and again when it is done.
 */
export const pluginsApply = () => call('plugins_apply');

// --- The managed tools -----------------------------------------------------------------------
// Every change of a tool's state comes as `tools:status` too (`onToolsStatus`).

/** yt-dlp's and Deno's states, in that order. Ask when the page opens; the event only says what changes. */
export const toolsStatus = () => call('tools_status');

/**
 * "Check now": checks a tool, due or not, and resolves with its state after; a check that failed
 * resolves with a `failed` state and its reason. It may take a while: a new version is downloaded.
 */
export const toolsCheck = (tool: ToolId) => call('tools_check', { tool });

// --- Links that failed -----------------------------------------------------------------------

/**
 * "Try again" and "Update and try again" on the card of a link that failed: opens `url` again as a
 * pasted link opens, and resolves with `null`. With `update` the tools are checked first and the
 * promise resolves after the download with what was found (`LinkUpdate`): the link is opened again
 * only when something new was put in place since it failed. Rejects with a `LoadIssue` for text
 * that is no http(s) link.
 */
export const streamRetry = (url: string, update: boolean) => call('stream_retry', { url, update });

// --- The qualities of a link -----------------------------------------------------------------
// What is known of a link comes as `stream:formats` too (`onStreamFormats`), for any link: compare
// its `url` with `path`.

/**
 * What is known of the qualities of the link that plays (yt-dlp is asked as soon as it starts to
 * load); `null` when what plays is no http(s) link. Ask when `path` changes; the event says what
 * changes after.
 */
export const streamFormats = () => call('stream_formats');

/**
 * Plays the link that plays with another quality from where it is, in place in the playlist:
 * `format` is a `ytdl-format` (`bv*[height<=?1080]+ba/b[height<=?1080]`), `null` for the default
 * of the settings. Kept for the link for the run, also across Apply. Rejects with a `QualityError`.
 */
export const playerSetQuality = (format: string | null) => call('player_set_quality', { format });
