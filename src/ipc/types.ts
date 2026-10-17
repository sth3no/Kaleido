/**
 * The IPC contract between the UI and Rust: every type that crosses `invoke` and `listen`,
 * written by hand from the serde types in src-tauri/src (Rust is the source of truth).
 *
 * What keeps the two sides together are the JSON fixtures in `src-tauri/tests/fixtures/ipc`:
 * the Rust test `ipc_fixtures_match_serde` checks them against the serde types, and
 * `contract.test.ts` checks them against the types below (`tsc` catches a field that is
 * missing or of another type, the test a name that no longer exists).
 *
 * Serde's conventions: structs and enum variants are camelCase, enums with data carry their
 * variant in `type` (the surface `Layout` in `kind`), and the names of mpv's properties stay
 * kebab-case.
 */

// ---------------------------------------------------------------------------------------------
// Player commands (src-tauri/src/player/command.rs)

/** How `seek.target` is read. */
export type SeekMode = 'absolute' | 'relative' | 'absolutePercent';

/** mpv's own name for subtitles is `sub`. */
export type TrackKind = 'audio' | 'sub' | 'video';

export type ScreenshotMode = 'subtitles' | 'video' | 'window' | 'eachFrame';

/**
 * What the UI may tell the player (`player_command`). Rust checks every number: volume 0 to 1000,
 * speed 0.01 to 100, sub scale 0.1 to 10, delays within ±600 s, sub margin 0 to 720; indexes are
 * unsigned 32-bit integers and a track id is 1 or more.
 */
export type PlayerCommand =
  | { type: 'togglePause' }
  | { type: 'setPause'; paused: boolean }
  /** `exact`: a precise seek instead of one to the nearest keyframe. */
  | { type: 'seek'; target: number; mode: SeekMode; exact: boolean }
  | { type: 'setVolume'; volume: number }
  | { type: 'setMute'; muted: boolean }
  | { type: 'setSpeed'; speed: number }
  /** `id: null` turns the track kind off. */
  | { type: 'selectTrack'; kind: TrackKind; id: number | null }
  | { type: 'setSubDelay'; seconds: number }
  | { type: 'setSubScale'; scale: number }
  | { type: 'setAudioDelay'; seconds: number }
  | { type: 'setSubMargin'; margin: number }
  | { type: 'playlistNext' }
  | { type: 'playlistPrev' }
  | { type: 'playlistPlay'; index: number }
  | { type: 'playlistRemove'; index: number }
  /** After the move the entry is at index `to`. */
  | { type: 'playlistMove'; from: number; to: number }
  | { type: 'screenshot'; mode: ScreenshotMode }
  | { type: 'setFullscreen'; on: boolean }
  | { type: 'setOntop'; on: boolean }
  | { type: 'stop' };

// ---------------------------------------------------------------------------------------------
// Input the UI did not handle (src-tauri/src/input.rs)

export type WheelKey = 'WHEEL_UP' | 'WHEEL_DOWN' | 'WHEEL_LEFT' | 'WHEEL_RIGHT';

/** What `player_input` takes; the key names are mpv's input.conf names. */
export type InputEvent =
  | { type: 'keyDown'; key: string }
  | { type: 'keyUp'; key: string }
  /** In physical pixels of mpv's window. */
  | { type: 'mouseMove'; x: number; y: number }
  | { type: 'buttonDown'; button: string }
  | { type: 'buttonUp'; button: string }
  /** `steps` whole notches of the wheel (the UI adds up the small steps of a touchpad). */
  | { type: 'wheel'; key: WheelKey; steps: number };

// ---------------------------------------------------------------------------------------------
// Opening files and links (src-tauri/src/player/load.rs, system/*)

export type LoadMode =
  /** Start the sources now, in place of what is open. */
  | 'replace'
  /** Add the sources to the playlist; they start if nothing is playing. */
  | 'append';

export type SourceError =
  /** No such file or folder. */
  | 'notFound'
  /** A scheme other than http and https. */
  | 'protocol'
  /** Not usable at all: empty, with control characters, a link that does not parse. */
  | 'invalid';

/** A source that was not opened, and why. */
export type LoadIssue = { source: string; kind: SourceError };

export type DialogPurpose = 'media' | 'subtitle';

export type PasteOutcome =
  /** The clipboard held a link, which now opens. */
  | 'played'
  /** No link on the clipboard: offer the paste field instead. */
  | 'empty';

// ---------------------------------------------------------------------------------------------
// The video surface and the glass over it (src-tauri/src/surface/layout.rs, glass.rs)

/** Where the video goes, in CSS px of the window. Tagged with `kind`, not `type`. */
export type Layout =
  /** The whole client area (the player page). */
  | { kind: 'full' }
  /** A frame of the animation between the player and the mini player. */
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  /** The mini player at rest: `w`×`h`, its bottom-right corner `right` and `bottom` from the window's. */
  | { kind: 'mini'; w: number; h: number; right: number; bottom: number }
  | { kind: 'hidden' };

/** A glass element as measured by the UI: CSS px in window coordinates, radius, opacity. */
export type GlassRect = {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  /** How much of the blur shows, 0 to 1. Left out: fully. */
  a?: number;
};

/**
 * A window button the UI draws and Windows hit-tests itself (src-tauri/src/surface/caption.rs):
 * CSS px in window coordinates, like a glass rectangle. Today only the maximise/restore button,
 * whose `HTMAXBUTTON` opens Windows 11's Snap Layouts (spec 5.1).
 */
export type CaptionButton = { x: number; y: number; w: number; h: number };

export type GlassReason =
  /** The user turned transparency off. */
  | 'user'
  /** Windows turned transparency effects off, or a high-contrast theme replaced them. */
  | 'system'
  /** The shader or the GPU failed; the glass stays off until Kaleido restarts. */
  | 'gpuFailure';

/** The payload of `glass:state`, and what `glass_state` returns. */
export type GlassState = { enabled: boolean; reason: GlassReason | null };

// ---------------------------------------------------------------------------------------------
// Timeline previews (src-tauri/src/thumbs.rs)

/** The payload of `player:thumb`: a new preview is stored and `thumb_get` returns it. */
export type ThumbReady = { width: number; height: number; seq: number };

/** What `thumbGet` decodes `thumb_get` into: the preview's RGBA pixels. */
export type ThumbFrame = { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> };

// ---------------------------------------------------------------------------------------------
// Settings (src-tauri/src/settings)

export type Language = 'system' | 'cs' | 'en';
export type ThemeMode = 'system' | 'dark' | 'light';
export type ReduceTransparency = 'auto' | 'on' | 'off';

export interface Appearance {
  mode: ThemeMode;
  /** `"kaleido"` (the rainbow) or `#RRGGBB`. */
  accent: string;
  /** `#RRGGBB`. */
  glassTint: string;
  /** 0.3 to 0.95. */
  glassOpacity: number;
  /** px, 0 to 40. */
  blur: number;
  /** 0.5 to 2. */
  saturation: number;
  /** px, 0 to 28. */
  radius: number;
  mica: boolean;
  reduceTransparency: ReduceTransparency;
  /** 0.9 to 1.5. */
  uiScale: number;
}

export interface Playback {
  /** What a file opened while another plays does. */
  openWhilePlaying: LoadMode;
}

/**
 * Kaleido's settings (settings.json), also the payload of `settings:changed`. The keys of a newer
 * Kaleido that this one does not know come along at the top level (Rust keeps them); they are not
 * modelled here and must never be sent back.
 */
export interface Settings {
  version: number;
  language: Language;
  appearance: Appearance;
  playback: Playback;
}

type Patch<T> = { [K in keyof T]?: (T[K] extends object ? Patch<T[K]> : T[K]) | null };

/**
 * What `settings_set` takes: a JSON merge patch of the settings, never the whole of them echoed
 * back (Rust refuses a key it does not know, and the `extra` keys of a newer Kaleido are unknown).
 * `null` takes a key out, so that it falls back to its default.
 */
export type SettingsPatch = Patch<Settings>;

/** Why a setting was not changed; in every case nothing changed. */
export type SettingsError =
  /** Not a key that may be changed, or a value the system does not offer. */
  | { type: 'notAllowed'; key: string }
  /** A value out of range or of the wrong form; `key` is the mpv option or the settings path. */
  | { type: 'invalid'; key: string; reason: string }
  /** The file could not be read or written. */
  | { type: 'io'; message: string }
  /** The player is not running (yet). */
  | { type: 'unavailable' };

/**
 * What Windows says about the look of the desktop (src-tauri/src/themes.rs): what
 * `system_appearance` returns and the payload of `system:appearance-changed`.
 */
export interface SystemAppearance {
  /** Windows' "Transparency effects" switch. */
  transparencyEffects: boolean;
  /** A high-contrast theme is on (the UI's `forced-colors`). */
  highContrast: boolean;
  /** The Windows build number, 0 if unknown; 22000 and up is Windows 11, which has Mica. */
  windowsBuild: number;
}

/** An audio output from mpv's `audio-device-list`. */
export type AudioDevice = {
  /** What `audio-device` takes (`auto`, `wasapi/{...}`). */
  name: string;
  /** What the user reads. */
  description: string;
};

/** Where a binding comes from. */
export type BindingSource =
  /** A line of Kaleido's own default input.conf. */
  | { type: 'kaleido' }
  /** The user's own input.conf, or one set from the settings. */
  | { type: 'user' }
  /** One of mpv's built-in bindings. */
  | { type: 'mpv' }
  /** A script's; `name` is the script. */
  | { type: 'plugin'; name: string };

/** A key and what it does now, for the shortcuts page. */
export type Binding = {
  key: string;
  /** The mpv command. A key the user silenced has `ignore`. */
  command: string;
  source: BindingSource;
  comment: string | null;
};

/** One entry of the license list on the About page. */
export type License = {
  name: string;
  version: string;
  /** The SPDX expression, or the name of the license. */
  license: string;
  /** Where to read about it or get its source. */
  url: string;
};

// ---------------------------------------------------------------------------------------------
// The player's state (src-tauri/src/player/state.rs)

/** The properties that changed, or all of them (`system_ui_ready`): mpv's property name → value. */
export type Snapshot = Record<string, unknown>;

/**
 * An entry of mpv's `track-list`. Of the ids `aid`, `sid` and `vid` mpv says `no` for none, which
 * arrives as `null`.
 */
export type Track = {
  id: number;
  type: TrackKind;
  title?: string;
  lang?: string;
  codec?: string;
  'codec-desc'?: string;
  default?: boolean;
  forced?: boolean;
  selected?: boolean;
  external?: boolean;
  'external-filename'?: string;
  image?: boolean;
  albumart?: boolean;
  'demux-w'?: number;
  'demux-h'?: number;
  'demux-fps'?: number;
  'demux-channel-count'?: number;
  'demux-samplerate'?: number;
};

/** An entry of mpv's `playlist`, as it arrives. */
export type PlaylistEntry = {
  /** The path or link as it was loaded; for a long path it starts with `\\?\`. */
  filename: string;
  title?: string;
  id?: number;
  /** Only on the entry that is current. */
  current?: boolean;
  playing?: boolean;
};

/** An entry of mpv's `chapter-list`. */
export type Chapter = { title: string; time: number };

/** mpv's `video-params`; the parts the UI reads. */
export type VideoParams = {
  pixelformat?: string;
  w?: number;
  h?: number;
  dw?: number;
  dh?: number;
  aspect?: number;
  par?: number;
  colormatrix?: string;
  colorlevels?: string;
  primaries?: string;
  /** `pq` and `hlg` are HDR. */
  gamma?: string;
  'sig-peak'?: number;
  rotate?: number;
};

/** mpv's `osd-dimensions`: the window, and the margins around the picture in it (px). */
export type OsdDimensions = { w: number; h: number; ml: number; mr: number; mt: number; mb: number };

// ---------------------------------------------------------------------------------------------
// Events (Rust emits them; src-tauri/src/lib.rs, player/state.rs, glass.rs, thumbs.rs, themes.rs, system, commands.rs)

/** Why a file stopped. */
export type EndReason = 'eof' | 'stop' | 'quit' | 'error' | 'redirect';

/** The payload of `player:end-file`. */
export type EndFile = { reason: EndReason; error: string | null };

/** The payload of `player:log`: only the warnings and errors of mpv's log. */
export type LogLine = { level: 'warn' | 'error' | 'fatal'; prefix: string; text: string };

/** The payload of `player:message`: a `script-message kaleido <args>`, without the `kaleido`. */
export type PlayerMessage = { args: string[] };

/** The payload of `player:state`: a batch of changes, newest value of each property. */
export type PlayerStateBatch = { changes: Record<string, unknown> };

/** The payload of `system:open-request`: Rust has handed the player `count` sources. */
export type OpenRequest = { count: number };

/** The payload of `player:file-loaded` and `system:paste-empty`: `{}`. */
export type EmptyPayload = Record<string, never>;

/** Every event Rust emits to the UI today, by name. */
export interface EventTable {
  'player:state': PlayerStateBatch;
  'player:file-loaded': EmptyPayload;
  'player:end-file': EndFile;
  'player:message': PlayerMessage;
  'player:log': LogLine;
  'player:thumb': ThumbReady;
  'system:open-request': OpenRequest;
  'system:paste-empty': EmptyPayload;
  'glass:state': GlassState;
  'settings:changed': Settings;
  'system:appearance-changed': SystemAppearance;
}

// ---------------------------------------------------------------------------------------------
// Commands (src-tauri/src/commands.rs)

/** What a command that returns nothing (Rust's `()`) resolves with. */
export type Nothing = null;

/**
 * Every command registered with Tauri, by name: the arguments `invoke` takes (the Rust parameters
 * in camelCase; `undefined` for none) and what the promise resolves to.
 */
export interface CommandTable {
  player_command: { args: { cmd: PlayerCommand }; result: Nothing };
  player_input: { args: { event: InputEvent }; result: Nothing };
  player_load: { args: { sources: string[]; mode: LoadMode }; result: Nothing };
  system_ui_ready: { args: undefined; result: Snapshot };
  system_open_dialog: { args: { purpose: DialogPurpose }; result: Nothing };
  system_paste: { args: undefined; result: PasteOutcome };
  system_open_text: { args: { text: string }; result: Nothing };
  system_open_roadmap: { args: undefined; result: Nothing };
  surface_set_layout: { args: { layout: Layout }; result: Nothing };
  surface_set_caption_buttons: { args: { rects: CaptionButton[] }; result: Nothing };
  glass_set_regions: { args: { rects: GlassRect[] }; result: Nothing };
  glass_state: { args: undefined; result: GlassState };
  thumb_request: { args: { seconds: number }; result: Nothing };
  thumb_clear: { args: undefined; result: Nothing };
  /** Raw bytes: see `thumbGet`, which decodes them. */
  thumb_get: { args: undefined; result: ArrayBuffer };
  settings_get: { args: undefined; result: Settings };
  settings_set: { args: { patch: SettingsPatch }; result: Settings };
  /** mpv option → value from mpv.conf or the player; `null` where there is none. */
  settings_get_mpv: { args: undefined; result: Record<string, string | null> };
  settings_set_mpv: { args: { key: string; value: string | null }; result: Nothing };
  settings_audio_devices: { args: undefined; result: AudioDevice[] };
  settings_bindings: { args: undefined; result: Binding[] };
  settings_rebind: { args: { key: string; newKey: string }; result: Nothing };
  settings_reset_binding: { args: { key: string }; result: Nothing };
  settings_list_shaders: { args: undefined; result: string[] };
  system_fonts: { args: undefined; result: string[] };
  system_diagnostics: { args: undefined; result: string };
  system_copy_diagnostics: { args: undefined; result: Nothing };
  system_open_logs: { args: undefined; result: Nothing };
  system_licenses: { args: undefined; result: License[] };
  system_appearance: { args: undefined; result: SystemAppearance };
  /** The system's language as a BCP 47 tag (`cs-CZ`); `en-US` where the system names none. */
  system_locale: { args: undefined; result: string };
}

/**
 * What the promise of a command that returns a `Result` rejects with (the `Err`). Tauri rejects
 * other commands, and these too, with a plain message when it cannot run them (bad arguments).
 */
export interface CommandErrors {
  player_command: string;
  player_load: LoadIssue[];
  system_open_text: LoadIssue;
  settings_set: SettingsError;
  settings_set_mpv: SettingsError;
  settings_rebind: SettingsError;
  settings_reset_binding: SettingsError;
  system_copy_diagnostics: string;
}
