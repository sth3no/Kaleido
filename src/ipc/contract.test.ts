/**
 * The UI's half of the contract with Rust. The JSON files in src-tauri/tests/fixtures/ipc are
 * what the Rust test `ipc_fixtures_match_serde` checks against the serde types. Here they are
 * checked against the TypeScript types, so that a type that drifts from Rust fails one of the two:
 *
 * - `tsc` (`npm run build`): each fixture is assigned to its type, below. A JSON module has no
 *   literal types, so a string is checked as a string (`Widen`); the names are checked at run time.
 *   The tables of the keys of every struct and of every variant of a tagged union (`Shape`,
 *   `Shapes`) are written for every key of their type, or they do not compile.
 * - this test: the fixtures have exactly the keys of those tables and exactly the names of the
 *   enums, in both directions (the Rust test holds the fixtures to the serde types the same
 *   way); the wrapper of each command calls `invoke` with its fixture's arguments; each `on…`
 *   function hands the callback the fixture's payload.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type EventCallback } from '@tauri-apps/api/event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import glassSetRegionsJson from '../../src-tauri/tests/fixtures/ipc/glass_set_regions.json';
import glassStateJson from '../../src-tauri/tests/fixtures/ipc/glass_state.json';
import glassStateEventJson from '../../src-tauri/tests/fixtures/ipc/glass.state.json';
import playerCommandJson from '../../src-tauri/tests/fixtures/ipc/player_command.json';
import playerEndFileEventJson from '../../src-tauri/tests/fixtures/ipc/player.end-file.json';
import playerEngineRestartedEventJson from '../../src-tauri/tests/fixtures/ipc/player.engine-restarted.json';
import playerFileLoadedEventJson from '../../src-tauri/tests/fixtures/ipc/player.file-loaded.json';
import playerInputJson from '../../src-tauri/tests/fixtures/ipc/player_input.json';
import playerLoadJson from '../../src-tauri/tests/fixtures/ipc/player_load.json';
import playerSetQualityJson from '../../src-tauri/tests/fixtures/ipc/player_set_quality.json';
import playerLogEventJson from '../../src-tauri/tests/fixtures/ipc/player.log.json';
import playerMessageEventJson from '../../src-tauri/tests/fixtures/ipc/player.message.json';
import playerStateEventJson from '../../src-tauri/tests/fixtures/ipc/player.state.json';
import playerThumbEventJson from '../../src-tauri/tests/fixtures/ipc/player.thumb.json';
import pluginsApplyJson from '../../src-tauri/tests/fixtures/ipc/plugins_apply.json';
import pluginsChangedEventJson from '../../src-tauri/tests/fixtures/ipc/plugins.changed.json';
import pluginsErrorEventJson from '../../src-tauri/tests/fixtures/ipc/plugins.error.json';
import pluginsListJson from '../../src-tauri/tests/fixtures/ipc/plugins_list.json';
import pluginsLogJson from '../../src-tauri/tests/fixtures/ipc/plugins_log.json';
import pluginsRestoreEssentialsJson from '../../src-tauri/tests/fixtures/ipc/plugins_restore_essentials.json';
import pluginsSetEnabledJson from '../../src-tauri/tests/fixtures/ipc/plugins_set_enabled.json';
import pluginsSetSettingJson from '../../src-tauri/tests/fixtures/ipc/plugins_set_setting.json';
import pluginsSettingsJson from '../../src-tauri/tests/fixtures/ipc/plugins_settings.json';
import pluginsUninstallJson from '../../src-tauri/tests/fixtures/ipc/plugins_uninstall.json';
import rejectsPlayerLoadJson from '../../src-tauri/tests/fixtures/ipc/rejects.player_load.json';
import rejectsPlayerSetQualityJson from '../../src-tauri/tests/fixtures/ipc/rejects.player_set_quality.json';
import rejectsPluginsSetSettingJson from '../../src-tauri/tests/fixtures/ipc/rejects.plugins_set_setting.json';
import rejectsSettingsSetJson from '../../src-tauri/tests/fixtures/ipc/rejects.settings_set.json';
import rejectsStreamRetryJson from '../../src-tauri/tests/fixtures/ipc/rejects.stream_retry.json';
import rejectsSystemOpenTextJson from '../../src-tauri/tests/fixtures/ipc/rejects.system_open_text.json';
import returnsPluginsListJson from '../../src-tauri/tests/fixtures/ipc/returns.plugins_list.json';
import returnsPluginsLogJson from '../../src-tauri/tests/fixtures/ipc/returns.plugins_log.json';
import returnsPluginsSettingsJson from '../../src-tauri/tests/fixtures/ipc/returns.plugins_settings.json';
import returnsSettingsAudioDevicesJson from '../../src-tauri/tests/fixtures/ipc/returns.settings_audio_devices.json';
import returnsSettingsBindingsJson from '../../src-tauri/tests/fixtures/ipc/returns.settings_bindings.json';
import returnsStreamFormatsJson from '../../src-tauri/tests/fixtures/ipc/returns.stream_formats.json';
import returnsSystemAppearanceJson from '../../src-tauri/tests/fixtures/ipc/returns.system_appearance.json';
import returnsSystemBrowsersJson from '../../src-tauri/tests/fixtures/ipc/returns.system_browsers.json';
import returnsSystemLicensesJson from '../../src-tauri/tests/fixtures/ipc/returns.system_licenses.json';
import returnsSystemPasteJson from '../../src-tauri/tests/fixtures/ipc/returns.system_paste.json';
import returnsToolsCheckJson from '../../src-tauri/tests/fixtures/ipc/returns.tools_check.json';
import returnsToolsStatusJson from '../../src-tauri/tests/fixtures/ipc/returns.tools_status.json';
import settingsAudioDevicesJson from '../../src-tauri/tests/fixtures/ipc/settings_audio_devices.json';
import settingsBindingsJson from '../../src-tauri/tests/fixtures/ipc/settings_bindings.json';
import settingsChangedEventJson from '../../src-tauri/tests/fixtures/ipc/settings.changed.json';
import settingsGetJson from '../../src-tauri/tests/fixtures/ipc/settings_get.json';
import settingsGetMpvJson from '../../src-tauri/tests/fixtures/ipc/settings_get_mpv.json';
import settingsListShadersJson from '../../src-tauri/tests/fixtures/ipc/settings_list_shaders.json';
import settingsRebindJson from '../../src-tauri/tests/fixtures/ipc/settings_rebind.json';
import settingsResetBindingJson from '../../src-tauri/tests/fixtures/ipc/settings_reset_binding.json';
import settingsSetJson from '../../src-tauri/tests/fixtures/ipc/settings_set.json';
import settingsSetMpvJson from '../../src-tauri/tests/fixtures/ipc/settings_set_mpv.json';
import streamFormatsEventJson from '../../src-tauri/tests/fixtures/ipc/stream.formats.json';
import streamFormatsJson from '../../src-tauri/tests/fixtures/ipc/stream_formats.json';
import streamRetryJson from '../../src-tauri/tests/fixtures/ipc/stream_retry.json';
import surfaceSetCaptionButtonsJson from '../../src-tauri/tests/fixtures/ipc/surface_set_caption_buttons.json';
import surfaceSetLayoutJson from '../../src-tauri/tests/fixtures/ipc/surface_set_layout.json';
import systemAppearanceEventJson from '../../src-tauri/tests/fixtures/ipc/system.appearance-changed.json';
import systemAppearanceJson from '../../src-tauri/tests/fixtures/ipc/system_appearance.json';
import systemBrowsersJson from '../../src-tauri/tests/fixtures/ipc/system_browsers.json';
import systemCopyDiagnosticsJson from '../../src-tauri/tests/fixtures/ipc/system_copy_diagnostics.json';
import systemDiagnosticsJson from '../../src-tauri/tests/fixtures/ipc/system_diagnostics.json';
import systemErrorEventJson from '../../src-tauri/tests/fixtures/ipc/system.error.json';
import systemFontsJson from '../../src-tauri/tests/fixtures/ipc/system_fonts.json';
import systemLicensesJson from '../../src-tauri/tests/fixtures/ipc/system_licenses.json';
import systemLocaleJson from '../../src-tauri/tests/fixtures/ipc/system_locale.json';
import systemOpenDialogJson from '../../src-tauri/tests/fixtures/ipc/system_open_dialog.json';
import systemOpenLogsJson from '../../src-tauri/tests/fixtures/ipc/system_open_logs.json';
import systemOpenRequestEventJson from '../../src-tauri/tests/fixtures/ipc/system.open-request.json';
import systemOpenRoadmapJson from '../../src-tauri/tests/fixtures/ipc/system_open_roadmap.json';
import systemOpenSourceJson from '../../src-tauri/tests/fixtures/ipc/system_open_source.json';
import systemOpenTextJson from '../../src-tauri/tests/fixtures/ipc/system_open_text.json';
import systemPasteEventJson from '../../src-tauri/tests/fixtures/ipc/system.paste-empty.json';
import systemPasteJson from '../../src-tauri/tests/fixtures/ipc/system_paste.json';
import systemUiErrorJson from '../../src-tauri/tests/fixtures/ipc/system_ui_error.json';
import systemUiReadyJson from '../../src-tauri/tests/fixtures/ipc/system_ui_ready.json';
import thumbClearJson from '../../src-tauri/tests/fixtures/ipc/thumb_clear.json';
import thumbGetJson from '../../src-tauri/tests/fixtures/ipc/thumb_get.json';
import thumbRequestJson from '../../src-tauri/tests/fixtures/ipc/thumb_request.json';
import toolsStatusEventJson from '../../src-tauri/tests/fixtures/ipc/tools.status.json';
import toolsCheckJson from '../../src-tauri/tests/fixtures/ipc/tools_check.json';
import toolsStatusJson from '../../src-tauri/tests/fixtures/ipc/tools_status.json';
import * as commands from './commands';
import * as events from './events';
import type {
  Appearance,
  AudioDevice,
  Binding,
  BindingSource,
  Browser,
  BrowserWarning,
  CaptionButton,
  Channel,
  CommandErrors,
  CommandTable,
  DialogPurpose,
  EndFile,
  EndReason,
  EventTable,
  FormatsState,
  GlassRect,
  GlassReason,
  GlassState,
  InputEvent,
  Language,
  Layout,
  License,
  LoadIssue,
  LoadMode,
  Localized,
  LogLine,
  OpenRequest,
  OptEntry,
  PasteOutcome,
  Playback,
  PlayerCommand,
  PlayerMessage,
  PlayerStateBatch,
  PluginError,
  PluginErrorEvent,
  PluginInfo,
  PluginSettings,
  PluginSource,
  PluginsState,
  QualityError,
  ReduceTransparency,
  ScreenshotMode,
  SeekMode,
  SettingKind,
  SettingSpec,
  Settings,
  SettingsError,
  SettingsForm,
  SourceError,
  SourcePage,
  StreamError,
  StreamFormat,
  StreamFormats,
  StreamInfo,
  SystemAppearance,
  ThemeMode,
  ThumbReady,
  ToolId,
  ToolState,
  ToolStatus,
  TrackKind,
  Updates,
  WheelKey,
} from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

// --- Types of the fixtures ---------------------------------------------------------------------

/** The type a JSON module gets for `T`: its strings are `string`, its numbers `number`. */
type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends readonly (infer Item)[]
        ? Widen<Item>[]
        : T extends object
          ? { [K in keyof T]: Widen<T[K]> }
          : T;

type Fixture<T> = Widen<T>[];

/** The arguments of a call: an object, empty for a command without arguments. */
type Args<K extends keyof CommandTable> = CommandTable[K]['args'] extends undefined
  ? Record<string, never>
  : CommandTable[K]['args'];

/** Arguments `invoke` takes, one sample per call, per command. */
const commandFixtures = {
  glass_set_regions: glassSetRegionsJson,
  glass_state: glassStateJson,
  player_command: playerCommandJson,
  player_input: playerInputJson,
  player_load: playerLoadJson,
  player_set_quality: playerSetQualityJson,
  plugins_apply: pluginsApplyJson,
  plugins_list: pluginsListJson,
  plugins_log: pluginsLogJson,
  plugins_restore_essentials: pluginsRestoreEssentialsJson,
  plugins_set_enabled: pluginsSetEnabledJson,
  plugins_set_setting: pluginsSetSettingJson,
  plugins_settings: pluginsSettingsJson,
  plugins_uninstall: pluginsUninstallJson,
  settings_audio_devices: settingsAudioDevicesJson,
  settings_bindings: settingsBindingsJson,
  settings_get: settingsGetJson,
  settings_get_mpv: settingsGetMpvJson,
  settings_list_shaders: settingsListShadersJson,
  settings_rebind: settingsRebindJson,
  settings_reset_binding: settingsResetBindingJson,
  settings_set: settingsSetJson,
  settings_set_mpv: settingsSetMpvJson,
  stream_formats: streamFormatsJson,
  stream_retry: streamRetryJson,
  surface_set_caption_buttons: surfaceSetCaptionButtonsJson,
  surface_set_layout: surfaceSetLayoutJson,
  system_appearance: systemAppearanceJson,
  system_browsers: systemBrowsersJson,
  system_copy_diagnostics: systemCopyDiagnosticsJson,
  system_diagnostics: systemDiagnosticsJson,
  system_fonts: systemFontsJson,
  system_licenses: systemLicensesJson,
  system_locale: systemLocaleJson,
  system_open_dialog: systemOpenDialogJson,
  system_open_logs: systemOpenLogsJson,
  system_open_roadmap: systemOpenRoadmapJson,
  system_open_source: systemOpenSourceJson,
  system_open_text: systemOpenTextJson,
  system_paste: systemPasteJson,
  system_ui_error: systemUiErrorJson,
  system_ui_ready: systemUiReadyJson,
  thumb_clear: thumbClearJson,
  thumb_get: thumbGetJson,
  thumb_request: thumbRequestJson,
  tools_check: toolsCheckJson,
  tools_status: toolsStatusJson,
} satisfies { [K in keyof CommandTable]: Fixture<Args<K>> };

/** The payloads Rust emits, per event. */
const eventFixtures = {
  'glass:state': glassStateEventJson,
  'player:end-file': playerEndFileEventJson,
  'player:engine-restarted': playerEngineRestartedEventJson,
  'player:file-loaded': playerFileLoadedEventJson,
  'player:log': playerLogEventJson,
  'player:message': playerMessageEventJson,
  'player:state': playerStateEventJson,
  'player:thumb': playerThumbEventJson,
  'plugins:changed': pluginsChangedEventJson,
  'plugins:error': pluginsErrorEventJson,
  'settings:changed': settingsChangedEventJson,
  'stream:formats': streamFormatsEventJson,
  'system:appearance-changed': systemAppearanceEventJson,
  'system:error': systemErrorEventJson,
  'system:open-request': systemOpenRequestEventJson,
  'system:paste-empty': systemPasteEventJson,
  'tools:status': toolsStatusEventJson,
} satisfies { [K in keyof EventTable]: Fixture<EventTable[K]> };

/** What a command resolves with, where that is more than a number or a string. */
const returnFixtures = {
  plugins_list: returnsPluginsListJson,
  plugins_log: returnsPluginsLogJson,
  plugins_settings: returnsPluginsSettingsJson,
  settings_audio_devices: returnsSettingsAudioDevicesJson,
  settings_bindings: returnsSettingsBindingsJson,
  stream_formats: returnsStreamFormatsJson,
  system_appearance: returnsSystemAppearanceJson,
  system_browsers: returnsSystemBrowsersJson,
  system_licenses: returnsSystemLicensesJson,
  system_paste: returnsSystemPasteJson,
  tools_check: returnsToolsCheckJson,
  tools_status: returnsToolsStatusJson,
} satisfies {
  [K in
    | 'plugins_list'
    | 'plugins_log'
    | 'plugins_settings'
    | 'settings_audio_devices'
    | 'settings_bindings'
    | 'stream_formats'
    | 'system_appearance'
    | 'system_browsers'
    | 'system_licenses'
    | 'system_paste'
    | 'tools_check'
    | 'tools_status']: Fixture<CommandTable[K]['result']>;
};

/** What a command rejects with (the `Err` of its `Result`). */
const rejectFixtures = {
  player_load: rejectsPlayerLoadJson,
  player_set_quality: rejectsPlayerSetQualityJson,
  plugins_set_setting: rejectsPluginsSetSettingJson,
  settings_set: rejectsSettingsSetJson,
  stream_retry: rejectsStreamRetryJson,
  system_open_text: rejectsSystemOpenTextJson,
} satisfies {
  [K in
    | 'player_load'
    | 'player_set_quality'
    | 'plugins_set_setting'
    | 'settings_set'
    | 'stream_retry'
    | 'system_open_text']: Fixture<CommandErrors[K]>;
};

// --- The names of the types --------------------------------------------------------------------

/** The names of a string union: all of them, or it does not compile. */
const names = <T extends string>(all: Record<T, true>): string[] => Object.keys(all);

/**
 * For a union tagged by `Tag`, per value of the tag the keys its variant has: all of them, or it
 * does not compile. A unit variant (`{ type: 'stop' }`) is the type of anything with a `type`, so
 * `tsc` cannot tell a variant's fields from a typo; the keys are compared at run time instead.
 */
type Shapes<U extends Record<Tag, string>, Tag extends string> = {
  [T in U[Tag]]: Record<keyof Extract<U, Record<Tag, T>>, true>;
};

const PLAYER_COMMAND_SHAPES: Shapes<PlayerCommand, 'type'> = {
  togglePause: { type: true },
  setPause: { type: true, paused: true },
  seek: { type: true, target: true, mode: true, exact: true },
  setVolume: { type: true, volume: true },
  setMute: { type: true, muted: true },
  setSpeed: { type: true, speed: true },
  selectTrack: { type: true, kind: true, id: true },
  setSubDelay: { type: true, seconds: true },
  setSubScale: { type: true, scale: true },
  setAudioDelay: { type: true, seconds: true },
  setSubMargin: { type: true, margin: true },
  playlistNext: { type: true },
  playlistPrev: { type: true },
  playlistPlay: { type: true, index: true },
  playlistRemove: { type: true, index: true },
  playlistMove: { type: true, from: true, to: true },
  screenshot: { type: true, mode: true },
  setFullscreen: { type: true, on: true },
  setOntop: { type: true, on: true },
  stop: { type: true },
};
const INPUT_SHAPES: Shapes<InputEvent, 'type'> = {
  keyDown: { type: true, key: true },
  keyUp: { type: true, key: true },
  mouseMove: { type: true, x: true, y: true },
  buttonDown: { type: true, button: true },
  buttonUp: { type: true, button: true },
  wheel: { type: true, key: true, steps: true },
};
const LAYOUT_SHAPES: Shapes<Layout, 'kind'> = {
  full: { kind: true },
  rect: { kind: true, x: true, y: true, w: true, h: true },
  mini: { kind: true, w: true, h: true, right: true, bottom: true },
  hidden: { kind: true },
};
const BINDING_SOURCE_SHAPES: Shapes<BindingSource, 'type'> = {
  kaleido: { type: true },
  user: { type: true },
  mpv: { type: true },
  plugin: { type: true, name: true },
};
const SETTINGS_ERROR_SHAPES: Shapes<SettingsError, 'type'> = {
  notAllowed: { type: true, key: true },
  invalid: { type: true, key: true, reason: true },
  io: { type: true, message: true },
  unavailable: { type: true },
};
const PLUGIN_ERROR_SHAPES: Shapes<PluginError, 'type'> = {
  notFound: { type: true, name: true },
  invalid: { type: true, key: true, reason: true },
  busy: { type: true },
  io: { type: true, message: true },
  unavailable: { type: true },
};
const FORMATS_STATE_SHAPES: Shapes<FormatsState, 'type'> = {
  loading: { type: true },
  ready: { type: true, info: true },
  failed: { type: true, error: true, message: true },
};

/**
 * For a struct type, an entry for every key of `T`, and whether the key may be left out: all of
 * them with the right answer, or it does not compile. `inside` is the same for the structs a field
 * holds.
 */
type Fields<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? 'optional' : 'required';
};
type Shape<T> = { fields: Fields<T>; inside?: { [K in keyof T]?: Shape<NonNullable<T[K]>> } };

// The structs of the contract. These tables are what keeps a field added to or taken out of a
// TypeScript type from going unnoticed; `contract.test.ts` compares them with the fixtures, which
// the Rust test holds to the serde types in both directions.
const GLASS_RECT: Shape<GlassRect> = {
  fields: { x: 'required', y: 'required', w: 'required', h: 'required', r: 'required', a: 'optional' },
};
const CAPTION_BUTTON: Shape<CaptionButton> = {
  fields: { x: 'required', y: 'required', w: 'required', h: 'required' },
};
const END_FILE: Shape<EndFile> = {
  fields: {
    reason: 'required',
    error: 'required',
    file: 'required',
    continues: 'required',
    streamError: 'required',
  },
};
const LOG_LINE: Shape<LogLine> = {
  fields: { level: 'required', prefix: 'required', text: 'required' },
};
const PLAYER_MESSAGE: Shape<PlayerMessage> = { fields: { args: 'required' } };
// What is in `changes` is mpv's property values, which Rust passes on as they are.
const PLAYER_STATE_BATCH: Shape<PlayerStateBatch> = { fields: { changes: 'required' } };
const THUMB_READY: Shape<ThumbReady> = {
  fields: { width: 'required', height: 'required', seq: 'required' },
};
const OPEN_REQUEST: Shape<OpenRequest> = { fields: { count: 'required' } };
const GLASS_STATE: Shape<GlassState> = { fields: { enabled: 'required', reason: 'required' } };
const APPEARANCE: Shape<Appearance> = {
  fields: {
    mode: 'required',
    accent: 'required',
    glassTint: 'required',
    glassOpacity: 'required',
    blur: 'required',
    saturation: 'required',
    radius: 'required',
    mica: 'required',
    reduceTransparency: 'required',
    uiScale: 'required',
  },
};
const SYSTEM_APPEARANCE: Shape<SystemAppearance> = {
  fields: { transparencyEffects: 'required', highContrast: 'required', windowsBuild: 'required' },
};
const PLAYBACK: Shape<Playback> = {
  fields: { openWhilePlaying: 'required', cookiesFromBrowser: 'required' },
};
const UPDATES: Shape<Updates> = { fields: { ytdlpChannel: 'required' } };
const SETTINGS: Shape<Settings> = {
  fields: {
    version: 'required',
    language: 'required',
    appearance: 'required',
    playback: 'required',
    updates: 'required',
  },
  inside: { appearance: APPEARANCE, playback: PLAYBACK, updates: UPDATES },
};
// The `source` of a binding is a tagged union: see `BINDING_SOURCE_SHAPES`.
const BINDING: Shape<Binding> = {
  fields: { key: 'required', command: 'required', source: 'required', comment: 'required' },
};
const AUDIO_DEVICE: Shape<AudioDevice> = { fields: { name: 'required', description: 'required' } };
const BROWSER: Shape<Browser> = {
  fields: { id: 'required', label: 'required', spec: 'required', warning: 'required' },
};
const LICENSE: Shape<License> = {
  fields: { name: 'required', version: 'required', license: 'required', url: 'required' },
};
const LOAD_ISSUE: Shape<LoadIssue> = { fields: { source: 'required', kind: 'required' } };
const LOCALIZED: Shape<Localized> = { fields: { en: 'required', cs: 'optional' } };
const PLUGIN_INFO: Shape<PluginInfo> = {
  fields: {
    name: 'required',
    scriptName: 'required',
    source: 'required',
    version: 'required',
    summary: 'required',
    enabled: 'required',
    running: 'required',
    incompatible: 'required',
    duplicate: 'required',
    errors: 'required',
    settings: 'required',
    copyOf: 'required',
  },
  inside: { summary: LOCALIZED },
};
// The `plugins` of a state are a list: see `PLUGIN_INFO`.
const PLUGINS_STATE: Shape<PluginsState> = {
  fields: { plugins: 'required', restartNeeded: 'required', removedEssentials: 'required', applying: 'required' },
};
const OPT_ENTRY: Shape<OptEntry> = { fields: { key: 'required', value: 'required' } };
// The `schema` is a list of `SettingSpec`s and the `entries` of `OptEntry`s: see those.
const PLUGIN_SETTINGS: Shape<PluginSettings> = {
  fields: { name: 'required', schema: 'required', entries: 'required', managed: 'required' },
};
const PLUGIN_ERROR_EVENT: Shape<PluginErrorEvent> = { fields: { name: 'required' } };
const TOOL_STATUS: Shape<ToolStatus> = {
  fields: { tool: 'required', state: 'required', version: 'required', checkedAt: 'required', error: 'required' },
};
const STREAM_FORMAT: Shape<StreamFormat> = {
  fields: {
    formatId: 'required',
    ext: 'required',
    height: 'required',
    width: 'required',
    fps: 'required',
    vcodec: 'required',
    acodec: 'required',
    dynamicRange: 'required',
    tbr: 'required',
    filesize: 'required',
    filesizeApprox: 'required',
    protocol: 'required',
  },
};
// The `formats` of a link are a list: see `STREAM_FORMAT`.
const STREAM_INFO: Shape<StreamInfo> = {
  fields: { title: 'required', duration: 'required', live: 'required', formats: 'required' },
};
// The `state` is a tagged union: see `FORMATS_STATE_SHAPES`.
const STREAM_FORMATS: Shape<StreamFormats> = {
  fields: { url: 'required', state: 'required', chosen: 'required' },
};

/** The setting of one kind. */
type SpecOf<K extends SettingKind> = Extract<SettingSpec, { type: K }>;
/**
 * The keys of each kind of setting, a struct tagged by `type` whose optional keys are left out
 * when absent: `expectVariants` wants every key in every sample, so each kind is checked as a
 * struct of its own. The texts inside (`label`, `description`) are checked as `Localized`.
 */
const SETTING_SPEC_SHAPES: { [K in SettingKind]: Shape<SpecOf<K>> } = {
  bool: {
    fields: { key: 'required', type: 'required', default: 'required', label: 'required', description: 'optional' },
  },
  int: {
    fields: {
      key: 'required',
      type: 'required',
      default: 'required',
      label: 'required',
      description: 'optional',
      min: 'optional',
      max: 'optional',
    },
  },
  float: {
    fields: {
      key: 'required',
      type: 'required',
      default: 'required',
      label: 'required',
      description: 'optional',
      min: 'optional',
      max: 'optional',
    },
  },
  string: {
    fields: { key: 'required', type: 'required', default: 'required', label: 'required', description: 'optional' },
  },
  enum: {
    fields: {
      key: 'required',
      type: 'required',
      default: 'required',
      label: 'required',
      description: 'optional',
      values: 'required',
    },
  },
  color: {
    fields: { key: 'required', type: 'required', default: 'required', label: 'required', description: 'optional' },
  },
};

/** What `expectShape` reads a `Shape<T>` as. */
type LooseShape = {
  fields: Record<string, 'optional' | 'required'>;
  inside?: Record<string, LooseShape>;
};

/**
 * The samples have exactly the fields of the struct, in both directions: none the type lacks, every
 * required one, every field in some sample, and a field that may be left out left out in some. The
 * same for the structs inside, through `inside`.
 */
function expectShape(samples: object[], shape: object, what: string) {
  const { fields, inside = {} } = shape as LooseShape;
  const known = Object.keys(fields);
  const found = samples as Record<string, unknown>[];
  expect(found.length, `${what}: no samples`).toBeGreaterThan(0);
  for (const sample of found) {
    const keys = Object.keys(sample);
    for (const key of keys) expect(known, `${what}: ${key} is not a field of the type`).toContain(key);
    for (const key of known) {
      if (fields[key] === 'required') expect(keys, `${what}: ${key} is required`).toContain(key);
    }
  }
  for (const key of known) {
    expect(
      found.some((sample) => key in sample),
      `${what}: no sample has ${key}`,
    ).toBe(true);
    if (fields[key] === 'optional') {
      expect(
        found.some((sample) => !(key in sample)),
        `${what}: no sample leaves out ${key}`,
      ).toBe(true);
    }
  }
  for (const [key, within] of Object.entries(inside)) {
    const held = found.flatMap((sample) => {
      const value = sample[key];
      return typeof value === 'object' && value !== null ? [value] : [];
    });
    expectShape(held, within, `${what}.${key}`);
  }
}

const SEEK_MODES = names<SeekMode>({ absolute: true, relative: true, absolutePercent: true });
const TRACK_KINDS = names<TrackKind>({ audio: true, sub: true, video: true });
const SCREENSHOT_MODES = names<ScreenshotMode>({
  subtitles: true,
  video: true,
  window: true,
  eachFrame: true,
});
const WHEEL_KEYS = names<WheelKey>({
  WHEEL_UP: true,
  WHEEL_DOWN: true,
  WHEEL_LEFT: true,
  WHEEL_RIGHT: true,
});
const LOAD_MODES = names<LoadMode>({ replace: true, append: true });
const DIALOG_PURPOSES = names<DialogPurpose>({ media: true, subtitle: true });
const SOURCE_PAGES = names<SourcePage>({ kaleido: true, libmpv: true });
const END_REASONS = names<EndReason>({ eof: true, stop: true, quit: true, error: true, redirect: true });
const LOG_LEVELS = names<LogLine['level']>({ warn: true, error: true, fatal: true });
const GLASS_REASONS = names<GlassReason>({ user: true, system: true, gpuFailure: true });
const PASTE_OUTCOMES = names<PasteOutcome>({ played: true, empty: true });
const SOURCE_ERRORS = names<SourceError>({ notFound: true, protocol: true, invalid: true });
const STREAM_ERRORS = names<StreamError>({
  outdated: true,
  missing: true,
  cookies: true,
  signIn: true,
  ageRestricted: true,
  geoBlocked: true,
  private: true,
  removed: true,
  network: true,
});
const LANGUAGES = names<Language>({ system: true, cs: true, en: true });
const THEME_MODES = names<ThemeMode>({ system: true, dark: true, light: true });
const REDUCE_TRANSPARENCY = names<ReduceTransparency>({ auto: true, on: true, off: true });
const PLUGIN_SOURCES = names<PluginSource>({ bundled: true, store: true, url: true, manual: true });
const SETTINGS_FORMS = names<SettingsForm>({ schema: true, keyValue: true });
const CHANNELS = names<Channel>({ stable: true, nightly: true });
const BROWSER_WARNINGS = names<BrowserWarning>({ chromiumCookies: true, noProfile: true });
/** What `--cookies-from-browser` of yt-dlp takes from Kaleido: a browser it knows, and a profile if there is a colon. */
const COOKIES_SPEC = /^(brave|chrome|chromium|edge|firefox|opera|safari|vivaldi|whale)(:.+)?$/;
const TOOL_IDS = names<ToolId>({ ytDlp: true, deno: true });
const TOOL_STATES = names<ToolState>({ missing: true, checking: true, downloading: true, ready: true, failed: true });
const QUALITY_ERRORS = names<QualityError>({ notAStream: true, invalid: true });
const SETTING_KINDS = names<SettingKind>({
  bool: true,
  int: true,
  float: true,
  string: true,
  enum: true,
  color: true,
});

/** The `field` of the samples whose `tag` is `value`. */
const fieldOf = (samples: object[], tag: string, value: string, field: string): string[] =>
  (samples as Record<string, unknown>[])
    .filter((sample) => sample[tag] === value)
    .map((sample) => String(sample[field]));

/** The samples use exactly the known names: no name of the type is left out of the fixtures. */
function expectAll(used: string[], known: string[], what: string) {
  expect([...new Set(used)].sort(), what).toEqual([...known].sort());
}

/** The samples use known names only. */
function expectKnown(used: string[], known: string[], what: string) {
  for (const name of used) expect(known, `${what}: ${name}`).toContain(name);
}

/**
 * Each sample of a tagged union is a variant of it with exactly its keys, and every variant is in
 * a sample.
 */
function expectVariants(samples: object[], tag: string, shapes: object, what: string) {
  const known = shapes as Record<string, Record<string, true>>;
  for (const sample of samples as Record<string, unknown>[]) {
    const variant = String(sample[tag]);
    expect(Object.keys(known), `${what}: ${variant} is not a variant`).toContain(variant);
    expect(Object.keys(sample).sort(), `${what}: ${variant}`).toEqual(Object.keys(known[variant] ?? {}).sort());
  }
  expectAll(samples.map((sample) => String((sample as Record<string, unknown>)[tag])), Object.keys(known), what);
}

describe('fixtures type-check against the IPC types', () => {
  test('player_command', () => {
    const cmds = commandFixtures.player_command.map(({ cmd }) => cmd);
    expectVariants(cmds, 'type', PLAYER_COMMAND_SHAPES, 'player command');
    expectAll(fieldOf(cmds, 'type', 'seek', 'mode'), SEEK_MODES, 'seek mode');
    expectAll(fieldOf(cmds, 'type', 'selectTrack', 'kind'), TRACK_KINDS, 'track kind');
    expectAll(fieldOf(cmds, 'type', 'screenshot', 'mode'), SCREENSHOT_MODES, 'screenshot mode');
  });

  test('player_input', () => {
    const inputs = commandFixtures.player_input.map(({ event }) => event);
    expectVariants(inputs, 'type', INPUT_SHAPES, 'input event');
    expectKnown(fieldOf(inputs, 'type', 'wheel', 'key'), WHEEL_KEYS, 'wheel key');
  });

  test('player_load, system_open_dialog, system_open_source and surface_set_layout', () => {
    expectAll(commandFixtures.player_load.map(({ mode }) => mode), LOAD_MODES, 'load mode');
    expectAll(commandFixtures.system_open_dialog.map(({ purpose }) => purpose), DIALOG_PURPOSES, 'purpose');
    // The UI names a page; the address is Rust's, so it is the page name and nothing else that is sent.
    expectAll(commandFixtures.system_open_source.map(({ which }) => which), SOURCE_PAGES, 'source page');
    for (const sample of commandFixtures.system_open_source) {
      expect(Object.keys(sample), 'system_open_source').toEqual(['which']);
    }
    expectVariants(
      commandFixtures.surface_set_layout.map(({ layout }) => layout),
      'kind',
      LAYOUT_SHAPES,
      'layout',
    );
  });

  test('the events', () => {
    expectAll(eventFixtures['player:end-file'].map(({ reason }) => reason), END_REASONS, 'end reason');
    expect(eventFixtures['player:end-file'].map(({ reason, error }) => [reason, error !== null])).toEqual(
      eventFixtures['player:end-file'].map(({ reason }) => [reason, reason === 'error']),
    );
    // Only an error is told with its file (a string, or null for an entry the playlist no longer
    // has) and with whether mpv goes on; the fixture has an error of each kind.
    const ends = eventFixtures['player:end-file'];
    const errors = ends.filter(({ reason }) => reason === 'error');
    expect(errors.some(({ file }) => typeof file === 'string')).toBe(true);
    expect(errors.some(({ file }) => file === null)).toBe(true);
    expect(errors.some(({ continues }) => continues)).toBe(true);
    expect(errors.some(({ continues }) => !continues)).toBe(true);
    for (const { reason, file, continues, streamError } of ends) {
      expect(file === null || typeof file === 'string').toBe(true);
      if (reason !== 'error') expect([file, continues, streamError]).toEqual([null, false, null]);
    }
    // Every class of failure is in the fixture, and each comes with a link: it is only a link that
    // yt-dlp fails for. A link whose failure Rust cannot class has none, and a file on a disk never has.
    expectAll(
      ends.flatMap(({ streamError }) => (streamError === null ? [] : [streamError])),
      STREAM_ERRORS,
      'stream error',
    );
    for (const { streamError, file } of ends) {
      if (streamError !== null) expect(file, streamError).toMatch(/^https?:\/\//i);
    }
    expect(errors.some(({ file, streamError }) => file?.startsWith('http') && streamError === null)).toBe(true);
    expect(errors.some(({ file, streamError }) => !file?.startsWith('http') && streamError === null)).toBe(true);
    expectAll(eventFixtures['player:log'].map(({ level }) => level), LOG_LEVELS, 'log level');
    const glass = eventFixtures['glass:state'];
    expectAll(glass.flatMap(({ reason }) => (reason === null ? [] : [reason])), GLASS_REASONS, 'glass reason');
    // The glass is on exactly when it has no reason to be off.
    for (const { enabled, reason } of glass) expect(enabled).toBe(reason === null);
  });

  test('settings:changed', () => {
    const changed = eventFixtures['settings:changed'];
    expectAll(changed.map(({ language }) => language), LANGUAGES, 'language');
    expectAll(changed.map(({ appearance }) => appearance.mode), THEME_MODES, 'mode');
    expectAll(
      changed.map(({ appearance }) => appearance.reduceTransparency),
      REDUCE_TRANSPARENCY,
      'reduce transparency',
    );
    expectAll(changed.map(({ playback }) => playback.openWhilePlaying), LOAD_MODES, 'open while playing');
    // The browser for the cookies: none in some samples, a spec of yt-dlp's in others.
    const cookies = changed.map(({ playback }) => playback.cookiesFromBrowser);
    expect(cookies.some((spec) => spec === null)).toBe(true);
    expect(cookies.some((spec) => spec !== null)).toBe(true);
    for (const spec of cookies) {
      if (spec !== null) expect(spec).toMatch(COOKIES_SPEC);
    }
    expectAll(changed.map(({ updates }) => updates.ytdlpChannel), CHANNELS, 'yt-dlp channel');
  });

  test('system:appearance-changed and system_appearance carry the same payloads', () => {
    const changed = eventFixtures['system:appearance-changed'];
    expect(returnFixtures.system_appearance).toEqual(changed);
    // Each switch is on in one sample and off in another, so that a constant would show.
    for (const key of ['transparencyEffects', 'highContrast'] as const) {
      expect([...new Set(changed.map((sample) => sample[key]))].sort(), key).toEqual([false, true]);
    }
    // Windows 10 and Windows 11 builds (Mica starts at 22000).
    expect(changed.some(({ windowsBuild }) => windowsBuild < 22000)).toBe(true);
    expect(changed.some(({ windowsBuild }) => windowsBuild >= 22000)).toBe(true);
  });

  test('structs have exactly the fields of their types, nested ones too', () => {
    // What the UI sends.
    expectShape(
      commandFixtures.glass_set_regions.flatMap(({ rects }) => rects),
      GLASS_RECT,
      'GlassRect',
    );
    expectShape(
      commandFixtures.surface_set_caption_buttons.flatMap(({ rects }) => rects),
      CAPTION_BUTTON,
      'CaptionButton',
    );
    // What Rust sends.
    expectShape(eventFixtures['player:end-file'], END_FILE, 'EndFile');
    expectShape(eventFixtures['player:log'], LOG_LINE, 'LogLine');
    expectShape(eventFixtures['player:message'], PLAYER_MESSAGE, 'PlayerMessage');
    expectShape(eventFixtures['player:state'], PLAYER_STATE_BATCH, 'PlayerStateBatch');
    expectShape(eventFixtures['player:thumb'], THUMB_READY, 'ThumbReady');
    expectShape(eventFixtures['system:open-request'], OPEN_REQUEST, 'OpenRequest');
    expectShape(eventFixtures['glass:state'], GLASS_STATE, 'GlassState');
    expectShape(eventFixtures['settings:changed'], SETTINGS, 'Settings');
    expectShape(eventFixtures['system:appearance-changed'], SYSTEM_APPEARANCE, 'SystemAppearance');
    for (const channel of [
      'player:file-loaded',
      'player:engine-restarted',
      'system:paste-empty',
      'system:error',
    ] as const) {
      for (const payload of eventFixtures[channel]) expect(Object.keys(payload), channel).toEqual([]);
    }
    expectShape(eventFixtures['plugins:changed'], PLUGINS_STATE, 'PluginsState');
    expectShape(
      eventFixtures['plugins:changed'].flatMap(({ plugins }) => plugins),
      PLUGIN_INFO,
      'PluginInfo',
    );
    expectShape(eventFixtures['plugins:error'], PLUGIN_ERROR_EVENT, 'PluginErrorEvent');
    expectShape(eventFixtures['tools:status'], TOOL_STATUS, 'ToolStatus');
    // What commands resolve or reject with.
    expectShape(returnFixtures.plugins_list, PLUGINS_STATE, 'PluginsState');
    expectShape(returnFixtures.plugins_settings, PLUGIN_SETTINGS, 'PluginSettings');
    expectShape(
      returnFixtures.plugins_settings.flatMap(({ entries }) => entries),
      OPT_ENTRY,
      'OptEntry',
    );
    expectShape(returnFixtures.plugins_log.flat(), LOG_LINE, 'LogLine');
    expectShape(returnFixtures.settings_bindings.flat(), BINDING, 'Binding');
    expectShape(returnFixtures.settings_audio_devices.flat(), AUDIO_DEVICE, 'AudioDevice');
    expectShape(returnFixtures.system_appearance, SYSTEM_APPEARANCE, 'SystemAppearance');
    expectShape(returnFixtures.system_browsers.flat(), BROWSER, 'Browser');
    expectShape(returnFixtures.system_licenses.flat(), LICENSE, 'License');
    expectShape(returnFixtures.tools_status.flat(), TOOL_STATUS, 'ToolStatus');
    expectShape(returnFixtures.tools_check, TOOL_STATUS, 'ToolStatus');
    expectShape(
      [...rejectFixtures.player_load.flat(), ...rejectFixtures.system_open_text, ...rejectFixtures.stream_retry],
      LOAD_ISSUE,
      'LoadIssue',
    );
  });

  test('what commands resolve with', () => {
    expectAll(returnFixtures.system_paste, PASTE_OUTCOMES, 'paste outcome');
    const [bindings = []] = returnFixtures.settings_bindings;
    expectVariants(
      bindings.map(({ source }) => source),
      'type',
      BINDING_SOURCE_SHAPES,
      'binding source',
    );
  });

  test('the browsers for the cookies', () => {
    const lists = returnFixtures.system_browsers;
    const browsers = lists.flat();
    expectAll(
      browsers.flatMap(({ warning }) => (warning === null ? [] : [warning])),
      BROWSER_WARNINGS,
      'browser warning',
    );
    // A PC with no browser gets an empty list, and no browser is listed twice in one.
    expect(lists.some((list) => list.length === 0)).toBe(true);
    for (const list of lists) expect(new Set(list.map(({ id }) => id)).size).toBe(list.length);
    // Only a browser without a profile has no spec to save; every other one has what the setting takes.
    for (const { id, spec, warning } of browsers) {
      expect(spec === '', id).toBe(warning === 'noProfile');
      if (spec !== '') expect(spec, id).toMatch(COOKIES_SPEC);
    }
    // The command takes no arguments.
    expect(commandFixtures.system_browsers).toEqual([{}]);
  });

  test('what commands reject with', () => {
    const [issues = []] = rejectFixtures.player_load;
    expectAll(
      [...issues, ...rejectFixtures.system_open_text].map(({ kind }) => kind),
      SOURCE_ERRORS,
      'source error',
    );
    // The retry of a link rejects as the paste field does: for a scheme that is no http, and for no link.
    expectAll(
      rejectFixtures.stream_retry.map(({ kind }) => kind),
      ['protocol', 'invalid'],
      'stream retry error',
    );
    expectVariants(rejectFixtures.settings_set, 'type', SETTINGS_ERROR_SHAPES, 'settings error');
    expectVariants(rejectFixtures.plugins_set_setting, 'type', PLUGIN_ERROR_SHAPES, 'plugin error');
  });

  test('the plugins', () => {
    // The list and the event carry the same state.
    expect(returnFixtures.plugins_list).toEqual(eventFixtures['plugins:changed']);
    const plugins = eventFixtures['plugins:changed'].flatMap(({ plugins }) => plugins);
    expectAll(plugins.map(({ source }) => source), PLUGIN_SOURCES, 'plugin source');
    expectAll(plugins.map(({ settings }) => settings), SETTINGS_FORMS, 'settings form');
    // Each kind of setting, with exactly its keys.
    const specs = returnFixtures.plugins_settings.flatMap(({ schema }) => schema ?? []);
    expectAll(specs.map(({ type }) => type), SETTING_KINDS, 'setting kind');
    for (const [kind, shape] of Object.entries(SETTING_SPEC_SHAPES)) {
      expectShape(
        specs.filter(({ type }) => type === kind),
        shape,
        `SettingSpec ${kind}`,
      );
    }
    // Every text, a summary, a label or a description, has its Czech or leaves it out.
    const texts: object[] = [
      ...plugins.flatMap(({ summary }) => (summary === null ? [] : [summary])),
      ...specs.flatMap(({ label, description }) => (description === undefined ? [label] : [label, description])),
    ];
    expectShape(texts, LOCALIZED, 'Localized');
    // A form or keys and values; managed keys are never among the entries.
    for (const { schema, entries, managed } of returnFixtures.plugins_settings) {
      expect(schema === null || Array.isArray(schema)).toBe(true);
      for (const { key } of entries) expect(managed).not.toContain(key);
    }
    expectKnown(
      returnFixtures.plugins_log.flat().map(({ level }) => level),
      LOG_LEVELS,
      'plugin log level',
    );
  });
});

describe('stream_retry', () => {
  test('is asked with and without the update of yt-dlp, for links', () => {
    expectAll(commandFixtures.stream_retry.map(({ update }) => String(update)), ['true', 'false'], 'update');
    for (const { url } of commandFixtures.stream_retry) expect(url).toMatch(/^https?:\/\//);
  });
});

describe('the qualities of a link', () => {
  const returned = returnFixtures.stream_formats.flatMap((found) => (found === null ? [] : [found]));
  const sent = [...eventFixtures['stream:formats'], ...returned];
  const states = sent.map(({ state }) => state);

  test('every state of a probe, with exactly its keys', () => {
    expectShape(sent, STREAM_FORMATS, 'StreamFormats');
    for (const samples of [eventFixtures['stream:formats'], returned]) {
      expectVariants(
        samples.map(({ state }) => state),
        'type',
        FORMATS_STATE_SHAPES,
        'formats state',
      );
    }
    const infos = states.flatMap((state) => ('info' in state && state.info !== undefined ? [state.info] : []));
    expectShape(infos, STREAM_INFO, 'StreamInfo');
    expectShape(
      infos.flatMap(({ formats }) => formats),
      STREAM_FORMAT,
      'StreamFormat',
    );
    // A live stream and a video.
    expect([...new Set(infos.map(({ live }) => live))].sort()).toEqual([false, true]);
  });

  test('a failure has a class where Rust knows one, and a message in any case', () => {
    const failures = states.flatMap((state) =>
      'message' in state && typeof state.message === 'string'
        ? [{ error: state.error ?? null, message: state.message }]
        : [],
    );
    expect(failures.some(({ error }) => error === null)).toBe(true);
    expect(failures.some(({ error }) => error !== null)).toBe(true);
    expectKnown(
      failures.flatMap(({ error }) => (error === null ? [] : [error])),
      STREAM_ERRORS,
      'stream error',
    );
    // No paths and no links in what yt-dlp said (spec 10.8).
    for (const { message } of failures) {
      expect(message).not.toBe('');
      expect(message).not.toMatch(/[a-z]+:\/\/|[A-Za-z]:\\/);
    }
  });

  test('every sample is of a link; nothing for no link; a chosen quality or the default', () => {
    for (const { url } of sent) expect(url).toMatch(/^https?:\/\//);
    expect(returnFixtures.stream_formats).toContain(null);
    expect(sent.some(({ chosen }) => chosen === null)).toBe(true);
    expect(sent.some(({ chosen }) => chosen !== null)).toBe(true);
    expect(commandFixtures.stream_formats).toEqual([{}]);
  });

  test('player_set_quality takes a format or the default, and rejects with a QualityError', () => {
    expect(commandFixtures.player_set_quality.map(({ format }) => format)).toEqual([
      'bv*[height<=?1080]+ba/b[height<=?1080]',
      null,
    ]);
    expectAll(rejectFixtures.player_set_quality, QUALITY_ERRORS, 'quality error');
  });
});

describe('the tools', () => {
  test('every tool and every state', () => {
    expectAll(commandFixtures.tools_check.map(({ tool }) => tool), TOOL_IDS, 'tool');
    const statuses = [
      ...eventFixtures['tools:status'],
      ...returnFixtures.tools_status.flat(),
      ...returnFixtures.tools_check,
    ];
    expectAll(eventFixtures['tools:status'].map(({ state }) => state), TOOL_STATES, 'tool state');
    expectAll(eventFixtures['tools:status'].map(({ tool }) => tool), TOOL_IDS, 'tool');
    expectKnown(statuses.map(({ state }) => state), TOOL_STATES, 'tool state');
    expectKnown(statuses.map(({ tool }) => tool), TOOL_IDS, 'tool');
    // A reason only with a failure; a failure of an earlier run has none any more.
    for (const { state, error } of statuses) if (error !== null) expect(state).toBe('failed');
    expect(statuses.some(({ state, error }) => state === 'failed' && error === null)).toBe(true);
    // `tools_status` lists yt-dlp, then Deno.
    for (const listed of returnFixtures.tools_status) expect(listed.map(({ tool }) => tool)).toEqual(['ytDlp', 'deno']);
  });
});

// --- The wrappers and the events ---------------------------------------------------------------

/**
 * What each wrapper does with its fixture's arguments. The names of the arguments (`newKey`) are
 * the Rust parameters' in camelCase. Tauri gives no way to read them, so they are copied by hand:
 * into `commands.ts`, into the fixtures and into the Rust test (`check_command`); this test
 * and that one hold the three together.
 */
const wrappers = {
  glass_set_regions: ({ rects }) => commands.glassSetRegions(rects),
  glass_state: () => commands.glassState(),
  player_command: ({ cmd }) => commands.playerCommand(cmd),
  player_input: ({ event }) => commands.playerInput(event),
  player_load: ({ sources, mode }) => commands.playerLoad(sources, mode),
  player_set_quality: ({ format }) => commands.playerSetQuality(format),
  plugins_apply: () => commands.pluginsApply(),
  plugins_list: () => commands.pluginsList(),
  plugins_log: ({ name }) => commands.pluginsLog(name),
  plugins_restore_essentials: () => commands.pluginsRestoreEssentials(),
  plugins_set_enabled: ({ name, enabled }) => commands.pluginsSetEnabled(name, enabled),
  plugins_set_setting: ({ name, key, value }) => commands.pluginsSetSetting(name, key, value),
  plugins_settings: ({ name }) => commands.pluginsSettings(name),
  plugins_uninstall: ({ name }) => commands.pluginsUninstall(name),
  settings_audio_devices: () => commands.settingsAudioDevices(),
  settings_bindings: () => commands.settingsBindings(),
  settings_get: () => commands.settingsGet(),
  settings_get_mpv: () => commands.settingsGetMpv(),
  settings_list_shaders: () => commands.settingsListShaders(),
  settings_rebind: ({ key, newKey }) => commands.settingsRebind(key, newKey),
  settings_reset_binding: ({ key }) => commands.settingsResetBinding(key),
  settings_set: ({ patch }) => commands.settingsSet(patch),
  settings_set_mpv: ({ key, value }) => commands.settingsSetMpv(key, value),
  stream_formats: () => commands.streamFormats(),
  stream_retry: ({ url, update }) => commands.streamRetry(url, update),
  surface_set_caption_buttons: ({ rects }) => commands.surfaceSetCaptionButtons(rects),
  surface_set_layout: ({ layout }) => commands.surfaceSetLayout(layout),
  system_appearance: () => commands.systemAppearance(),
  system_browsers: () => commands.systemBrowsers(),
  system_copy_diagnostics: () => commands.systemCopyDiagnostics(),
  system_diagnostics: () => commands.systemDiagnostics(),
  system_fonts: () => commands.systemFonts(),
  system_licenses: () => commands.systemLicenses(),
  system_locale: () => commands.systemLocale(),
  system_open_dialog: ({ purpose }) => commands.systemOpenDialog(purpose),
  system_open_logs: () => commands.systemOpenLogs(),
  system_open_roadmap: () => commands.systemOpenRoadmap(),
  system_open_source: ({ which }) => commands.systemOpenSource(which),
  system_open_text: ({ text }) => commands.systemOpenText(text),
  system_paste: () => commands.systemPaste(),
  system_ui_error: ({ message }) => commands.systemUiError(message),
  system_ui_ready: () => commands.systemUiReady(),
  thumb_clear: () => commands.thumbClear(),
  thumb_get: () => commands.thumbGet(),
  thumb_request: ({ seconds }) => commands.thumbRequest(seconds),
  tools_check: ({ tool }) => commands.toolsCheck(tool),
  tools_status: () => commands.toolsStatus(),
} satisfies { [K in keyof CommandTable]: (args: CommandTable[K]['args']) => Promise<unknown> };

/** The `on…` function of each event. */
const subscribers = {
  'glass:state': events.onGlassState,
  'player:end-file': events.onEndFile,
  'player:engine-restarted': events.onEngineRestarted,
  'player:file-loaded': events.onFileLoaded,
  'player:log': events.onLog,
  'player:message': events.onMessage,
  'player:state': events.onPlayerState,
  'player:thumb': events.onThumb,
  'plugins:changed': events.onPluginsChanged,
  'plugins:error': events.onPluginsError,
  'settings:changed': events.onSettingsChanged,
  'stream:formats': events.onStreamFormats,
  'system:appearance-changed': events.onSystemAppearanceChanged,
  'system:error': events.onSystemError,
  'system:open-request': events.onOpenRequest,
  'system:paste-empty': events.onPasteEmpty,
  'tools:status': events.onToolsStatus,
} satisfies { [K in keyof EventTable]: (callback: (payload: EventTable[K]) => void) => Promise<unknown> };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset();
});

describe('commands', () => {
  test.each(Object.keys(commandFixtures))(
    '%s: the wrapper calls invoke with the name and the arguments of every fixture sample',
    async (name) => {
      vi.mocked(invoke).mockImplementation((() =>
        // `thumb_get` answers with bytes: none before the first preview.
        Promise.resolve(name === 'thumb_get' ? new ArrayBuffer(0) : undefined)) as unknown as typeof invoke);
      const samples = (commandFixtures as Record<string, object[]>)[name] ?? [];
      const wrap = (wrappers as unknown as Record<string, (args: unknown) => Promise<unknown>>)[name];
      expect(samples.length, name).toBeGreaterThan(0);
      expect(wrap, name).toBeTypeOf('function');

      for (const sample of samples) {
        vi.mocked(invoke).mockClear();
        await wrap?.(sample);
        expect(invoke).toHaveBeenCalledTimes(1);
        if (Object.keys(sample).length === 0) expect(invoke).toHaveBeenCalledWith(name);
        else expect(invoke).toHaveBeenCalledWith(name, sample);
      }
    },
  );
});

describe('events', () => {
  test.each(Object.keys(eventFixtures))('%s: the callback gets every payload of the fixture', async (channel) => {
    const handlers: EventCallback<unknown>[] = [];
    vi.mocked(listen).mockImplementation(((_: string, handler: EventCallback<unknown>) => {
      handlers.push(handler);
      return Promise.resolve(() => undefined);
    }) as unknown as typeof listen);
    const subscribe = (
      subscribers as unknown as Record<string, (callback: (payload: unknown) => void) => Promise<unknown>>
    )[channel];
    const received: unknown[] = [];

    await subscribe?.((payload) => received.push(payload));

    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith(channel, expect.any(Function));
    const payloads = (eventFixtures as Record<string, unknown[]>)[channel] ?? [];
    expect(payloads.length, channel).toBeGreaterThan(0);
    for (const payload of payloads) handlers[0]?.({ event: channel, id: 0, payload });
    expect(received).toEqual(payloads);
  });
});

describe('the fixtures folder', () => {
  test('every fixture file is one this test checks', () => {
    const files = Object.keys(import.meta.glob('../../src-tauri/tests/fixtures/ipc/*.json'))
      .map((path) => (path.split('/').at(-1) ?? path).replace(/\.json$/, ''))
      .sort();
    const checked = [
      ...Object.keys(commandFixtures),
      ...Object.keys(eventFixtures).map((channel) => channel.replace(':', '.')),
      ...Object.keys(returnFixtures).map((command) => `returns.${command}`),
      ...Object.keys(rejectFixtures).map((command) => `rejects.${command}`),
    ].sort();
    expect(files).toEqual(checked);
  });
});
