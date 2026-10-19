/**
 * What the settings page offers (spec 8.10): one descriptor per setting, which says where its value
 * lives (an mpv option in mpv.conf, or a path in Kaleido's settings.json), which field edits it and
 * which texts it has. The sections, the search and the page are all driven by this list, so a later
 * task adds a setting by adding a descriptor (and its texts) and nothing else.
 *
 * The bounds and the words of the mpv options mirror `MPV_SETTINGS` in
 * src-tauri/src/settings/mpv_keys.rs. Rust checks every value again; the field keeps the user from
 * choosing one it would refuse. Every text is an i18n key (`labelKey`, `keywordsKey`, `hintKey`,
 * the options' `labelKey` and a slider's `unitKey`), in both locale files.
 *
 * Shortcuts and About have no descriptors: they are lists of bindings and of facts, not rows of
 * settings (sections/Shortcuts.tsx, sections/About.tsx). Updates has one (the channel of yt-dlp) between
 * rows of its own that show the tools (sections/Updates.tsx).
 */

import type { SettingsPatch } from '../ipc/types';
import { AUDIO_ONLY_SELECTOR, heightSelector } from '../streams/quality';

export type SectionId =
  | 'playback'
  | 'subtitles'
  | 'audio'
  | 'video'
  | 'appearance'
  | 'shortcuts'
  | 'updates'
  | 'about';

/** The sections in the order the page lists them. */
export const SECTIONS: readonly SectionId[] = [
  'playback',
  'subtitles',
  'audio',
  'video',
  'appearance',
  'shortcuts',
  'updates',
  'about',
];

export interface SelectOption {
  /** The value that is saved; `''` stands for "not set" (the option line leaves mpv.conf). */
  value: string;
  labelKey: string;
}

export type FieldKind =
  /** `on` and `off` are the words mpv.conf has for the two states (`yes` and `no` where left out). */
  | { kind: 'toggle'; on?: string; off?: string }
  | {
      kind: 'select';
      options: readonly SelectOption[];
      /**
       * The text of a value that is none of the options (the key of the text): the field then lists it
       * as one more choice, the one that is chosen, under this name. Choosing another option replaces it.
       * Left out, such a value is shown as it is.
       */
      customLabelKey?: string;
    }
  | {
      kind: 'slider';
      min: number;
      max: number;
      step: number;
      unitKey?: string;
      /** The range is a fraction (0.3 to 0.95) that the field writes as a percentage (30 to 95 %). */
      percent?: boolean;
    }
  /** `#RRGGBB` or `#AARRGGBB`; with `alpha: false` `#RRGGBB` only. */
  | { kind: 'color'; alpha?: boolean }
  /** The accent: `kaleido` (the rainbow), or one colour as `#RRGGBB`. */
  | { kind: 'accent' }
  /** A font family out of the installed ones. */
  | { kind: 'font' }
  /** Language codes separated by commas. */
  | { kind: 'langList' }
  /** An audio output out of mpv's. */
  | { kind: 'device' }
  /** Files of the shaders folder. */
  | { kind: 'shaderList' }
  /** The browser whose cookies yt-dlp takes, out of the ones Rust finds on this PC; `''` for none. */
  | { kind: 'browser' };

/** Where a setting is kept: an mpv option, or a dotted path into Kaleido's settings. */
export type SettingTarget = { mpv: string } | { kaleido: string };

export interface SettingDescriptor {
  /** Unique: the mpv option, or the settings path. */
  id: string;
  section: SectionId;
  labelKey: string;
  /** A comma-separated list of other words the search finds the setting by. */
  keywordsKey?: string;
  /** A short line under the label. */
  hintKey?: string;
  field: FieldKind;
  target: SettingTarget;
}

export function isMpvTarget(target: SettingTarget): target is { mpv: string } {
  return 'mpv' in target;
}

// --- The settings --------------------------------------------------------------------------------

/** The texts of the setting called `name` in the locale files (`settings.items.<name>`). */
const texts = (name: string) => ({
  labelKey: `settings.items.${name}.label`,
  keywordsKey: `settings.items.${name}.keywords`,
});

/** An option of the setting called `name`; `key` is the last part of its text's key. */
const option = (name: string, value: string, key: string): SelectOption => ({
  value,
  labelKey: `settings.items.${name}.options.${key}`,
});

/** Settings that only apply when the player starts the next time (Rulings R22, R25). */
const AT_START_HINT = 'settings.hints.atStart';

const PERCENT = 'settings.units.percent';
const PIXELS = 'settings.units.px';

/** An option of the language picker, whose texts (`settings.language.*`) exist since Task 15. */
const language = (value: string): SelectOption => ({ value, labelKey: `settings.language.${value}` });

export const DESCRIPTORS: readonly SettingDescriptor[] = [
  // Playback
  {
    id: 'hwdec',
    section: 'playback',
    ...texts('hwdec'),
    field: {
      kind: 'select',
      options: [
        option('hwdec', 'auto-safe', 'autoSafe'),
        option('hwdec', 'auto-copy-safe', 'autoCopySafe'),
        option('hwdec', 'no', 'off'),
      ],
    },
    target: { mpv: 'hwdec' },
  },
  {
    // "Playlist from folder" is `autocreate-playlist`: filter (the other videos of the folder) or no.
    id: 'autocreate-playlist',
    section: 'playback',
    ...texts('playlistFromFolder'),
    field: { kind: 'toggle', on: 'filter', off: 'no' },
    target: { mpv: 'autocreate-playlist' },
  },
  {
    id: 'save-position-on-quit',
    section: 'playback',
    ...texts('savePosition'),
    field: { kind: 'toggle' },
    target: { mpv: 'save-position-on-quit' },
  },
  {
    id: 'playback.openWhilePlaying',
    section: 'playback',
    ...texts('openWhilePlaying'),
    field: {
      kind: 'select',
      options: [
        option('openWhilePlaying', 'replace', 'replace'),
        option('openWhilePlaying', 'append', 'append'),
      ],
    },
    target: { kaleido: 'playback.openWhilePlaying' },
  },
  {
    // The default quality of links is mpv's `ytdl-format`, which `ytdl_hook` reads for every link it opens
    // (plan decision 10). The presets are Rust's `STREAM_QUALITY_PRESETS` in its order, `''` is yt-dlp's
    // own default; a test reads them from mpv_keys.rs.
    id: 'ytdl-format',
    section: 'playback',
    ...texts('streamQuality'),
    hintKey: 'settings.items.streamQuality.hint',
    field: {
      kind: 'select',
      options: [
        option('streamQuality', '', 'best'),
        option('streamQuality', heightSelector(2160), 'p2160'),
        option('streamQuality', heightSelector(1440), 'p1440'),
        option('streamQuality', heightSelector(1080), 'p1080'),
        option('streamQuality', heightSelector(720), 'p720'),
        option('streamQuality', heightSelector(480), 'p480'),
        option('streamQuality', AUDIO_ONLY_SELECTOR, 'audio'),
      ],
      // A `ytdl-format` the user wrote in mpv.conf by hand.
      customLabelKey: 'settings.items.streamQuality.custom',
    },
    target: { mpv: 'ytdl-format' },
  },
  {
    // The browser whose cookies yt-dlp takes for links (plan decision 13): `BROWSER` or `BROWSER:PROFILE`.
    id: 'playback.cookiesFromBrowser',
    section: 'playback',
    ...texts('cookiesFromBrowser'),
    hintKey: 'settings.items.cookiesFromBrowser.hint',
    field: { kind: 'browser' },
    target: { kaleido: 'playback.cookiesFromBrowser' },
  },

  // Subtitles
  {
    id: 'sub-font',
    section: 'subtitles',
    ...texts('subFont'),
    field: { kind: 'font' },
    target: { mpv: 'sub-font' },
  },
  {
    id: 'sub-font-size',
    section: 'subtitles',
    ...texts('subFontSize'),
    field: { kind: 'slider', min: 10, max: 120, step: 1 },
    target: { mpv: 'sub-font-size' },
  },
  {
    id: 'sub-color',
    section: 'subtitles',
    ...texts('subColor'),
    field: { kind: 'color' },
    target: { mpv: 'sub-color' },
  },
  {
    id: 'sub-border-color',
    section: 'subtitles',
    ...texts('subBorderColor'),
    field: { kind: 'color' },
    target: { mpv: 'sub-border-color' },
  },
  {
    id: 'sub-border-size',
    section: 'subtitles',
    ...texts('subBorderSize'),
    field: { kind: 'slider', min: 0, max: 10, step: 0.5 },
    target: { mpv: 'sub-border-size' },
  },
  {
    id: 'sub-back-color',
    section: 'subtitles',
    ...texts('subBackColor'),
    field: { kind: 'color' },
    target: { mpv: 'sub-back-color' },
  },
  {
    id: 'slang',
    section: 'subtitles',
    ...texts('subLanguages'),
    field: { kind: 'langList' },
    target: { mpv: 'slang' },
  },

  // Audio
  {
    id: 'audio-device',
    section: 'audio',
    ...texts('audioDevice'),
    field: { kind: 'device' },
    target: { mpv: 'audio-device' },
  },
  {
    // The default volume: it applies from the next start, the playing volume does not jump (R25).
    id: 'volume',
    section: 'audio',
    ...texts('volume'),
    hintKey: AT_START_HINT,
    field: { kind: 'slider', min: 0, max: 100, step: 1, unitKey: PERCENT },
    target: { mpv: 'volume' },
  },
  {
    id: 'volume-max',
    section: 'audio',
    ...texts('volumeMax'),
    field: { kind: 'slider', min: 100, max: 1000, step: 5, unitKey: PERCENT },
    target: { mpv: 'volume-max' },
  },
  {
    id: 'alang',
    section: 'audio',
    ...texts('audioLanguages'),
    field: { kind: 'langList' },
    target: { mpv: 'alang' },
  },

  // Video
  {
    id: 'deinterlace',
    section: 'video',
    ...texts('deinterlace'),
    field: {
      kind: 'select',
      options: [
        option('deinterlace', 'auto', 'auto'),
        option('deinterlace', 'no', 'off'),
        option('deinterlace', 'yes', 'on'),
      ],
    },
    target: { mpv: 'deinterlace' },
  },
  {
    id: 'tone-mapping',
    section: 'video',
    ...texts('toneMapping'),
    field: {
      kind: 'select',
      // The values are mpv's words; the texts' keys cannot hold a `.`, so they are spelled without.
      options: [
        option('toneMapping', 'auto', 'auto'),
        option('toneMapping', 'clip', 'clip'),
        option('toneMapping', 'mobius', 'mobius'),
        option('toneMapping', 'reinhard', 'reinhard'),
        option('toneMapping', 'hable', 'hable'),
        option('toneMapping', 'bt.2390', 'bt2390'),
        option('toneMapping', 'bt.2446a', 'bt2446a'),
        option('toneMapping', 'spline', 'spline'),
        option('toneMapping', 'st2094-40', 'st209440'),
        option('toneMapping', 'st2094-10', 'st209410'),
      ],
    },
    target: { mpv: 'tone-mapping' },
  },
  {
    id: 'hdr-compute-peak',
    section: 'video',
    ...texts('hdrComputePeak'),
    field: {
      kind: 'select',
      options: [
        option('hdrComputePeak', 'auto', 'auto'),
        option('hdrComputePeak', 'yes', 'on'),
        option('hdrComputePeak', 'no', 'off'),
      ],
    },
    target: { mpv: 'hdr-compute-peak' },
  },
  {
    // mpv applies a profile when it starts, and `apply-profile` cannot be undone (R22).
    id: 'profile',
    section: 'video',
    ...texts('qualityPreset'),
    hintKey: AT_START_HINT,
    field: {
      kind: 'select',
      options: [
        option('qualityPreset', '', 'none'),
        option('qualityPreset', 'fast', 'fast'),
        option('qualityPreset', 'high-quality', 'highQuality'),
      ],
    },
    target: { mpv: 'profile' },
  },
  {
    id: 'glsl-shaders',
    section: 'video',
    ...texts('shaders'),
    hintKey: 'settings.items.shaders.hint',
    field: { kind: 'shaderList' },
    target: { mpv: 'glsl-shaders' },
  },

  // Appearance (Kaleido's settings.json). The language is here too (Ruling R48). The words and the
  // bounds mirror Rust's `Language`, `ThemeMode`, `ReduceTransparency` and `GLASS_OPACITY` and the
  // other ranges in src-tauri/src/settings/store.rs; Rust checks every value again.
  {
    id: 'language',
    section: 'appearance',
    // Texts of the language picker, which exist since Task 15.
    labelKey: 'settings.language.label',
    keywordsKey: 'settings.items.language.keywords',
    field: { kind: 'select', options: [language('system'), language('cs'), language('en')] },
    target: { kaleido: 'language' },
  },
  {
    id: 'appearance.mode',
    section: 'appearance',
    ...texts('mode'),
    field: {
      kind: 'select',
      options: [
        option('mode', 'system', 'system'),
        option('mode', 'dark', 'dark'),
        option('mode', 'light', 'light'),
      ],
    },
    target: { kaleido: 'appearance.mode' },
  },
  {
    id: 'appearance.accent',
    section: 'appearance',
    ...texts('accent'),
    field: { kind: 'accent' },
    target: { kaleido: 'appearance.accent' },
  },
  {
    id: 'appearance.glassTint',
    section: 'appearance',
    ...texts('glassTint'),
    field: { kind: 'color', alpha: false },
    target: { kaleido: 'appearance.glassTint' },
  },
  {
    id: 'appearance.glassOpacity',
    section: 'appearance',
    ...texts('glassOpacity'),
    field: { kind: 'slider', min: 0.3, max: 0.95, step: 0.05, unitKey: PERCENT, percent: true },
    target: { kaleido: 'appearance.glassOpacity' },
  },
  {
    id: 'appearance.blur',
    section: 'appearance',
    ...texts('blur'),
    field: { kind: 'slider', min: 0, max: 40, step: 1, unitKey: PIXELS },
    target: { kaleido: 'appearance.blur' },
  },
  {
    id: 'appearance.saturation',
    section: 'appearance',
    ...texts('saturation'),
    field: { kind: 'slider', min: 0.5, max: 2, step: 0.05, unitKey: PERCENT, percent: true },
    target: { kaleido: 'appearance.saturation' },
  },
  {
    id: 'appearance.radius',
    section: 'appearance',
    ...texts('radius'),
    field: { kind: 'slider', min: 0, max: 28, step: 1, unitKey: PIXELS },
    target: { kaleido: 'appearance.radius' },
  },
  {
    // Windows 11 only: the section says why it is off on Windows 10 (`Appearance`).
    id: 'appearance.mica',
    section: 'appearance',
    ...texts('mica'),
    hintKey: 'settings.items.mica.hint',
    field: { kind: 'toggle' },
    target: { kaleido: 'appearance.mica' },
  },
  {
    id: 'appearance.reduceTransparency',
    section: 'appearance',
    ...texts('reduceTransparency'),
    field: {
      kind: 'select',
      options: [
        option('reduceTransparency', 'auto', 'auto'),
        option('reduceTransparency', 'on', 'on'),
        option('reduceTransparency', 'off', 'off'),
      ],
    },
    target: { kaleido: 'appearance.reduceTransparency' },
  },
  {
    id: 'appearance.uiScale',
    section: 'appearance',
    ...texts('uiScale'),
    field: { kind: 'slider', min: 0.9, max: 1.5, step: 0.05, unitKey: PERCENT, percent: true },
    target: { kaleido: 'appearance.uiScale' },
  },

  // Updates (Kaleido's settings.json). The tools themselves are rows of the section's own, with the
  // channel between them; the app's channel comes with the updater (M4). The words are Rust's `Channel`.
  {
    // The search finds the whole section by it, so its keywords name the tools it shows (Deno and the
    // libmpv have no setting of their own).
    id: 'updates.ytdlpChannel',
    section: 'updates',
    ...texts('ytdlpChannel'),
    hintKey: 'settings.items.ytdlpChannel.hint',
    field: {
      kind: 'select',
      options: [option('ytdlpChannel', 'stable', 'stable'), option('ytdlpChannel', 'nightly', 'nightly')],
    },
    target: { kaleido: 'updates.ytdlpChannel' },
  },
];

/** The settings of a section, in the order of the list. */
export function descriptorsOf(section: SectionId): SettingDescriptor[] {
  return DESCRIPTORS.filter((descriptor) => descriptor.section === section);
}

// --- Paths into Kaleido's settings -----------------------------------------------------------------

/** The value at a dotted `path` (`playback.openWhilePlaying`) of `root`, `undefined` where there is none. */
export function getPath(root: unknown, path: string): unknown {
  let node = root;
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * The patch for `settings_set` that changes the value at `path` and nothing else:
 * `playback.openWhilePlaying` and `'append'` give `{ playback: { openWhilePlaying: 'append' } }`.
 * Rust merges it into the settings, and refuses a key it does not know, so the whole of the
 * settings is never sent back.
 */
export function patchFor(path: string, value: unknown): SettingsPatch {
  return path
    .split('.')
    .reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as SettingsPatch;
}
