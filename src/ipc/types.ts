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

/**
 * A page about the sources of what Kaleido ships (spec 11.6). The UI names the page, Rust has the
 * address: no command opens a link the UI makes up.
 */
export type SourcePage =
  /** The releases of Kaleido, with the tag of the sources of each. */
  | 'kaleido'
  /** The sources of the libmpv build Kaleido ships. */
  | 'libmpv';

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
  /**
   * The browser whose cookies yt-dlp takes for links, as `--cookies-from-browser` has it:
   * `BROWSER` or `BROWSER:PROFILE` (one of `Browser.spec`), `null` for none.
   */
  cookiesFromBrowser: string | null;
}

/** yt-dlp's release channel: its stable releases, or its nightly builds. Deno has only its stable ones. */
export type Channel = 'stable' | 'nightly';

/** Settings → Updates. The app's own channel comes with the updater (M4). */
export interface Updates {
  /** Where yt-dlp comes from; a change is checked at once. */
  ytdlpChannel: Channel;
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
  updates: Updates;
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

/** Why a `Browser` may not work for cookies. */
export type BrowserWarning =
  /**
   * A Chromium-based browser: on Windows yt-dlp mostly cannot read its cookies (Chrome 127 and
   * newer encrypt them for the browser alone, and a running browser locks the database), and the
   * link then fails as a whole. Firefox and its forks work, also while the browser runs.
   */
  | 'chromiumCookies'
  /** A browser yt-dlp does not know by name, and none of its profiles has cookies: `spec` is empty. */
  | 'noProfile';

/** A browser on this PC whose cookies yt-dlp can use (`system_browsers`). */
export type Browser = {
  /** `firefox`, `edge`, `chrome`, `brave`, `opera`, `vivaldi`, `chromium`, `librewolf`, `zen`, `floorp` or `arc`. */
  id: string;
  /** The name the user reads: `Firefox`, `Microsoft Edge`, `Google Chrome`, ... */
  label: string;
  /**
   * What `playback.cookiesFromBrowser` takes for it: the id for a browser yt-dlp knows,
   * `firefox:<profile folder>` for a fork of Firefox, `chromium:<profile folder>` for Arc. Empty
   * for `noProfile`: there is nothing to save, so never offer to.
   */
  spec: string;
  warning: BrowserWarning | null;
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
// Plugins (src-tauri/src/plugins/mod.rs, registry.rs, schema.rs)

/** Where a plugin came from; `manual` for a script `plugins.json` does not know. */
export type PluginSource = 'bundled' | 'store' | 'url' | 'manual';

/** How a plugin's settings are edited: a form from its schema, or its keys and values. */
export type SettingsForm = 'schema' | 'keyValue';

/** A text in English and, where there is one, in Czech; show `en` where `cs` is missing. */
export type Localized = { en: string; cs?: string };

type SettingBase = { key: string; label: Localized; description?: Localized };

/**
 * One setting of a plugin's schema (spec 7.2). `default` is what the script uses while its
 * `script-opts` file does not set the key; the bounds of a number are inclusive.
 */
export type SettingSpec =
  | (SettingBase & { type: 'bool'; default: boolean })
  | (SettingBase & { type: 'int'; default: number; min?: number; max?: number })
  | (SettingBase & { type: 'float'; default: number; min?: number; max?: number })
  | (SettingBase & { type: 'string'; default: string })
  | (SettingBase & { type: 'enum'; default: string; values: string[] })
  /** `#RRGGBB` or `#AARRGGBB`. */
  | (SettingBase & { type: 'color'; default: string });

export type SettingKind = SettingSpec['type'];

/** One script in the config folder, as the plugins page lists it. */
export type PluginInfo = {
  /**
   * What every plugin command takes as `name`: a plugin Kaleido installed by its folder, any other
   * folder by its name, any other file by its name with the extension (`my-plugin.lua`); ` (2)`
   * and up where that is taken already. Show it as it is.
   */
  name: string;
  /** What mpv calls its client (the prefix of its log lines). */
  scriptName: string;
  source: PluginSource;
  version: string | null;
  /** What an essential does; `null` for the others. */
  summary: Localized | null;
  /** In `scripts\`: mpv loads it at the next start of the player core. */
  enabled: boolean;
  /** In the core that runs now. Off but running: the change waits for Apply. */
  running: boolean;
  /** Draws its own interface over the video (uosc, ModernZ): label it, with the reason. */
  incompatible: boolean;
  /** On, and another script that is on has its name to mpv: both run, one numbered. */
  duplicate: boolean;
  /** Errors it logged in this run; above 0, the "reports errors" badge, with `pluginsLog`. */
  errors: number;
  settings: SettingsForm;
  /**
   * The essential this is the user's own copy of: Kaleido writes no options for it, so it works
   * with the user's own settings (for thumbfast: its previews depend on them).
   */
  copyOf: string | null;
};

/** What `plugins_list` (and every plugin change) returns and `plugins:changed` carries. */
export type PluginsState = {
  /** In the order mpv loads them. */
  plugins: PluginInfo[];
  /** A change waits for Apply: show the apply bar. */
  restartNeeded: boolean;
  /** Essentials "Restore essentials" brings back; the button shows while there are any. */
  removedEssentials: string[];
  /**
   * Apply runs, until the new core plays on. The player's state meanwhile (an empty playlist, an
   * idle player) is the restart, not the player having stopped.
   */
  applying: boolean;
};

/** A key and its value in a plugin's `script-opts` file. */
export type OptEntry = { key: string; value: string };

/** What `plugins_settings` and `plugins_set_setting` return. */
export type PluginSettings = {
  name: string;
  /** The form's settings; `null` for a plugin edited as keys and values. */
  schema: SettingSpec[] | null;
  /** What the file sets, in its order; never a managed key. */
  entries: OptEntry[];
  /** Keys Kaleido sets itself; never offer them. */
  managed: string[];
};

/** Why a plugin change did not happen; in every case nothing changed. */
export type PluginError =
  /** No plugin of that name (any more): list again. */
  | { type: 'notFound'; name: string }
  /** A setting's value or key that cannot be set; show `reason` at the field. */
  | { type: 'invalid'; key: string; reason: string }
  /** Apply runs; try again when it is done. */
  | { type: 'busy' }
  /** A file could not be moved, read or written, or plugins.json is left alone. */
  | { type: 'io'; message: string }
  /** The player is not running, or Apply could not start a new core. */
  | { type: 'unavailable' };

/** The payload of `plugins:error`: the plugin logged its first error of the run. */
export type PluginErrorEvent = { name: string };

// ---------------------------------------------------------------------------------------------
// The managed tools (src-tauri/src/tools/mod.rs)

/** A tool Kaleido manages: yt-dlp for links, Deno for yt-dlp's YouTube. */
export type ToolId = 'ytDlp' | 'deno';

export type ToolState =
  /** Not installed (yet), and not tried in this run. */
  | 'missing'
  /** A check runs: the release's checksum is being read. */
  | 'checking'
  /** A check found a new version, which is being downloaded and put in place. */
  | 'downloading'
  /** Installed, and the last check went through. */
  | 'ready'
  /**
   * The last check failed, and an installed tool is still there and used; or the Deno that is
   * there is too old for yt-dlp (`error` says so).
   */
  | 'failed';

/** A tool's state: what `tools_status` lists (yt-dlp, then Deno), `tools_check` returns and `tools:status` carries. */
export type ToolStatus = {
  tool: ToolId;
  state: ToolState;
  /** The installed tool's version; `null` while none is installed. */
  version: string | null;
  /** The last check that reached the release, RFC 3339 in UTC. */
  checkedAt: string | null;
  /** Why it failed, while it is `failed` and this run of Kaleido knows (in English). */
  error: string | null;
};

// ---------------------------------------------------------------------------------------------
// The qualities of a link (src-tauri/src/streams.rs, tools/ytdlp.rs)

/** One format of a link as yt-dlp lists it, with what the list of qualities needs. */
export type StreamFormat = {
  /** What `ytdl-format` names it by. */
  formatId: string;
  ext: string;
  height: number | null;
  width: number | null;
  fps: number | null;
  /** `null` also for an audio-only format. */
  vcodec: string | null;
  /** `null` also for a video-only format. */
  acodec: string | null;
  /** `SDR`, `HDR10`, `HLG`, ... */
  dynamicRange: string | null;
  /** Kbit/s. */
  tbr: number | null;
  /** Bytes. */
  filesize: number | null;
  /** Bytes, yt-dlp's estimate where it does not know the size. */
  filesizeApprox: number | null;
  /** `https`, `m3u8_native`, `http_dash_segments`, ... */
  protocol: string | null;
};

/** A link as yt-dlp sees it (`yt-dlp -J`). */
export type StreamInfo = {
  title: string | null;
  /** Seconds; `null` for a live stream and where the site does not say. */
  duration: number | null;
  /**
   * A live stream, one to come, or one that has ended and has no recording yet: it plays from the
   * live edge. A recording of a past stream is not live.
   */
  live: boolean;
  /** In yt-dlp's order, the worst first; empty where yt-dlp lists none. */
  formats: StreamFormat[];
};

/** Where the probe of a link is. */
export type FormatsState =
  /** yt-dlp is asked. */
  | { type: 'loading' }
  | { type: 'ready'; info: StreamInfo }
  /**
   * yt-dlp could not say: `error` is the class of the failure where Rust knows one (`missing`
   * without a yt-dlp), `message` the last line yt-dlp wrote, without paths and links (in English).
   */
  | { type: 'failed'; error: StreamError | null; message: string };

/** What is known of the qualities of a link: the payload of `stream:formats`, and what `stream_formats` returns. */
export type StreamFormats = {
  /** The link as mpv's `path` has it: compare it with `path`, the event comes for any link. */
  url: string;
  state: FormatsState;
  /** The `ytdl-format` chosen for the link in this run; `null` for the default (Settings → Playback). */
  chosen: string | null;
};

/** Why `player_set_quality` changed nothing. */
export type QualityError =
  /** What plays is no http(s) link, or nothing plays. */
  | 'notAStream'
  /** The format is not one Rust passes on (the check of the command line's `--format`). */
  | 'invalid';

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
// Events (Rust emits them; src-tauri/src/lib.rs, player/state.rs, glass.rs, thumbs.rs, themes.rs, system, commands.rs, streams.rs)

/** Why a file stopped. */
export type EndReason = 'eof' | 'stop' | 'quit' | 'error' | 'redirect';

/**
 * Why a link did not play, read by Rust from what mpv's `ytdl_hook` logged for it (yt-dlp's own
 * words, see src-tauri/src/player/stream_error.rs).
 */
export type StreamError =
  /** yt-dlp no longer understands the site (an extractor that is out of date): a newer yt-dlp may. */
  | 'outdated'
  /** There is no yt-dlp to run (still downloading, or the download failed): as `outdated`. */
  | 'missing'
  /** The cookies of the browser the user chose cannot be read. */
  | 'cookies'
  /** The site wants the user signed in (also "confirm you are not a bot"). */
  | 'signIn'
  /** The video is for adults. */
  | 'ageRestricted'
  /** Not available in the user's region. */
  | 'geoBlocked'
  /** A private video. */
  | 'private'
  /** Deleted, terminated, or never there. */
  | 'removed'
  /** yt-dlp could not reach the site. */
  | 'network';

/**
 * The payload of `player:end-file`. For an error (`reason: "error"`), and only then, Rust has looked
 * at mpv's playlist as it is at that moment:
 *
 * - `file` is the entry that failed: its `filename` as the playlist has it (a path, with the
 *   `\\?\` of a long one, or a link), found by the id of the entry; `null` where the playlist no
 *   longer has it.
 * - `continues`: mpv goes on by itself, because an entry follows the failed one, or the playlist
 *   loops and has another entry to play. `false` where it does not, or Rust could not tell.
 * - `streamError`: for a `file` that is an http(s) link, why yt-dlp failed; `null` where the lines
 *   of `ytdl_hook` say nothing Rust knows.
 *
 * Any other end has `file: null`, `continues: false` and `streamError: null`.
 */
export type EndFile = {
  reason: EndReason;
  error: string | null;
  file: string | null;
  continues: boolean;
  streamError: StreamError | null;
};

/** The payload of `player:log`: only the warnings and errors of mpv's log. */
export type LogLine = { level: 'warn' | 'error' | 'fatal'; prefix: string; text: string };

/** The payload of `player:message`: a `script-message kaleido <args>`, without the `kaleido`. */
export type PlayerMessage = { args: string[] };

/** The payload of `player:state`: a batch of changes, newest value of each property. */
export type PlayerStateBatch = { changes: Record<string, unknown> };

/** The payload of `system:open-request`: Rust has handed the player `count` sources. */
export type OpenRequest = { count: number };

/** The payload of `player:file-loaded`, `player:engine-restarted`, `system:paste-empty` and `system:error`: `{}`. */
export type EmptyPayload = Record<string, never>;

/** Every event Rust emits to the UI today, by name. */
export interface EventTable {
  'player:state': PlayerStateBatch;
  'player:file-loaded': EmptyPayload;
  'player:engine-restarted': EmptyPayload;
  'player:end-file': EndFile;
  'player:message': PlayerMessage;
  'player:log': LogLine;
  'player:thumb': ThumbReady;
  'system:open-request': OpenRequest;
  'system:paste-empty': EmptyPayload;
  'system:error': EmptyPayload;
  'glass:state': GlassState;
  'settings:changed': Settings;
  'system:appearance-changed': SystemAppearance;
  'plugins:changed': PluginsState;
  'plugins:error': PluginErrorEvent;
  'tools:status': ToolStatus;
  'stream:formats': StreamFormats;
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
  system_open_source: { args: { which: SourcePage }; result: Nothing };
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
  /** What the UI's error boundary caught, with its stacks, for kaleido.log. */
  system_ui_error: { args: { message: string }; result: Nothing };
  system_licenses: { args: undefined; result: License[] };
  system_appearance: { args: undefined; result: SystemAppearance };
  /** The system's language as a BCP 47 tag (`cs-CZ`); `en-US` where the system names none. */
  system_locale: { args: undefined; result: string };
  /** The browsers on this PC that yt-dlp may take cookies from, Firefox first; empty if none. */
  system_browsers: { args: undefined; result: Browser[] };
  plugins_list: { args: undefined; result: PluginsState };
  plugins_set_enabled: { args: { name: string; enabled: boolean }; result: PluginsState };
  plugins_uninstall: { args: { name: string }; result: PluginsState };
  plugins_restore_essentials: { args: undefined; result: PluginsState };
  plugins_settings: { args: { name: string }; result: PluginSettings };
  /** `value: null` takes the key out: the script's default. */
  plugins_set_setting: {
    args: { name: string; key: string; value: string | null };
    result: PluginSettings;
  };
  /** The plugin's last errors of this run, the oldest first. */
  plugins_log: { args: { name: string }; result: LogLine[] };
  plugins_apply: { args: undefined; result: PluginsState };
  /** yt-dlp's and Deno's states, in that order. */
  tools_status: { args: undefined; result: ToolStatus[] };
  /** Checks a tool now, due or not; a failed check resolves with a `failed` state. */
  tools_check: { args: { tool: ToolId }; result: ToolStatus };
  /**
   * Opens a link that failed again, as a pasted link opens. With `update` yt-dlp is checked first
   * (due or not) and the promise resolves once the link is handed to the player, so after the
   * download; an update that fails does not stop the retry. Rejects with a `LoadIssue` for text
   * that is no http(s) link, before anything is updated.
   */
  stream_retry: { args: { url: string; update: boolean }; result: Nothing };
  /** What is known of the qualities of the link that plays; `null` when what plays is no link. */
  stream_formats: { args: undefined; result: StreamFormats | null };
  /**
   * Plays the link that plays with the quality `format` (a `ytdl-format`; `null` for the default)
   * from where it is, in place in the playlist. Resolves once the reload is queued; the choice comes
   * as `stream:formats` too. Rejects with a `QualityError`.
   */
  player_set_quality: { args: { format: string | null }; result: Nothing };
}

/**
 * What the promise of a command that returns a `Result` rejects with (the `Err`). Tauri rejects
 * other commands, and these too, with a plain message when it cannot run them (bad arguments).
 */
export interface CommandErrors {
  player_command: string;
  player_load: LoadIssue[];
  system_open_text: LoadIssue;
  stream_retry: LoadIssue;
  settings_set: SettingsError;
  settings_set_mpv: SettingsError;
  settings_rebind: SettingsError;
  settings_reset_binding: SettingsError;
  system_copy_diagnostics: string;
  plugins_set_enabled: PluginError;
  plugins_uninstall: PluginError;
  plugins_restore_essentials: PluginError;
  plugins_settings: PluginError;
  plugins_set_setting: PluginError;
  plugins_apply: PluginError;
  player_set_quality: QualityError;
}
