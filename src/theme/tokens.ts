/**
 * Design tokens (spec 8.1). Every colour, size, radius, shadow, duration and the focus ring the
 * components use is a token, and a token is a CSS variable (`--k-<group>-<name>`, kebab-case):
 * components read `var(--k-…)` and nothing else, so that the appearance settings, the light and
 * dark modes, reduced transparency and high contrast change the whole UI by changing variables.
 *
 * The values come from the mockups (key-screens-v2.html, player-direction.html): the rainbow
 * "Kaleido" accent, the glass (white edge, highlight in the top left corner, soft shadow), the
 * deep violet backdrop and the type sizes. Where the appearance settings (Rust's `Appearance`,
 * ranges in settings/store.rs) have a say, `tokensFromAppearance` applies them within the same
 * ranges.
 *
 * Everything here is pure, except `applyTokens`, which writes variables to an element.
 */

import type { Appearance, ReduceTransparency, SystemAppearance, ThemeMode } from '../ipc/types';

/** `dark` or `light`: what the mode `system` resolves to. */
export type ResolvedMode = 'dark' | 'light';

// --- Ranges --------------------------------------------------------------------------------------

/**
 * Spec 8.9: the glass under text is never more transparent than this, whatever the setting says
 * (the setting goes down to 0.3), so that text stays readable over any video.
 */
export const GLASS_TEXT_MIN_OPACITY = 0.45;
export const GLASS_OPACITY_MAX = 0.95;
/** Blur radius in px; the shader and `backdrop-filter` use it. */
export const BLUR_RANGE = { min: 0, max: 40 } as const;
export const SATURATION_RANGE = { min: 0.5, max: 2 } as const;
/** Corner radius of panels in px. */
export const RADIUS_RANGE = { min: 0, max: 28 } as const;
/** Spec 8.9: the UI scale is 90 to 150 %. */
export const UI_SCALE_MIN = 0.9;
export const UI_SCALE_MAX = 1.5;
/** The first Windows 11 build: Mica exists from here on (Rust: `themes::MICA_MIN_BUILD`). */
export const MICA_MIN_BUILD = 22000;

/** What the settings hold before they are read, and in a fresh install (Rust: `Appearance::default`). */
export const DEFAULT_APPEARANCE: Appearance = {
  mode: 'system',
  accent: 'kaleido',
  glassTint: '#16161c',
  glassOpacity: 0.55,
  blur: 24,
  saturation: 1.4,
  radius: 20,
  mica: true,
  reduceTransparency: 'auto',
  uiScale: 1,
};

/** Windows' appearance before it is read: the effects are on, no Mica (the build is not known). */
export const DEFAULT_SYSTEM_APPEARANCE: SystemAppearance = {
  transparencyEffects: true,
  highContrast: false,
  windowsBuild: 0,
};

// --- The tokens ----------------------------------------------------------------------------------

export interface Tokens {
  color: {
    /** The solid colour of the app's background (also the first paint, index.html). */
    bg: string;
    /** The background of the pages: a gradient. On Windows 11 with Mica the window shows Mica instead. */
    backdrop: string;
    text: string;
    textMuted: string;
    textSubtle: string;
    border: string;
    divider: string;
    /** Under the pointer. */
    hover: string;
    /** The chosen item of a list, the page in the sidebar. */
    selected: string;
    glassBorder: string;
    /** The light in the top left corner of a glass element. */
    glassHighlight: string;
    /** Text on glass: light or dark, whichever the glass tint makes readable. */
    onGlass: string;
    /** Text on the accent (a button with the accent as its background). */
    onAccent: string;
    danger: string;
  };
  glass: {
    /** `#rrggbb`. */
    tint: string;
    /** 0 to 1, never below `GLASS_TEXT_MIN_OPACITY`. */
    opacity: number;
    /** px. */
    blur: number;
    saturation: number;
  };
  accent: {
    /** A `linear-gradient(…)`: the rainbow for "kaleido", else the colour twice. */
    gradient: string;
    /** `#rrggbb`: one colour for borders, rings and text. */
    solid: string;
  };
  /** px. */
  radius: { s: number; m: number; l: number; pill: number };
  font: {
    family: string;
    /** px: 11 / 12 / 13 / 15 / 20 / 28 (spec 8.7). */
    size: { xs: number; s: number; m: number; l: number; xl: number; xxl: number };
  };
  /** px. */
  space: { xs: number; s: number; m: number; l: number; xl: number; xxl: number };
  shadow: {
    /** The edge light and the drop shadow of glass. */
    glass: string;
    popover: string;
    /** Under text on glass, so that it stays readable over any video. */
    text: string;
  };
  motion: {
    /** ms: the islands and panels open in 150 to 250 ms (spec 8.6). */
    fast: number;
    base: number;
    slow: number;
    /** The spring curve (an easing with a little overshoot). */
    spring: string;
  };
  focus: {
    /** An `outline` (it survives forced colours, a `box-shadow` does not). */
    ring: string;
    /** px. */
    offset: number;
  };
}

const LIGHT_TEXT = '#ffffff';
const DARK_TEXT = '#1b1730';
const KALEIDO_SOLID = '#a98bff';
/** The progress bar of the mockups: cyan to violet to pink. */
const KALEIDO_GRADIENT = 'linear-gradient(90deg, #7fd8ff, #a98bff, #ff8fd0)';
/** The text of the mockups' white buttons: a dark violet. */
const ON_ACCENT_DARK = '#2a1d4d';

/** The colours that depend on the mode only. */
const PALETTE: Record<ResolvedMode, Omit<Tokens['color'], 'onGlass' | 'onAccent'>> = {
  dark: {
    bg: '#15122b',
    backdrop: 'radial-gradient(120% 90% at 0% 0%, #2a2350 0%, #15122b 55%, #0d0b1c 100%)',
    text: '#ffffff',
    textMuted: 'rgba(255, 255, 255, 0.72)',
    textSubtle: 'rgba(255, 255, 255, 0.6)',
    border: 'rgba(255, 255, 255, 0.18)',
    divider: 'rgba(255, 255, 255, 0.12)',
    hover: 'rgba(255, 255, 255, 0.1)',
    selected: 'rgba(255, 255, 255, 0.18)',
    glassBorder: 'rgba(255, 255, 255, 0.3)',
    glassHighlight: 'rgba(255, 255, 255, 0.26)',
    danger: '#ff6b6b',
  },
  light: {
    bg: '#f4f2fb',
    backdrop: 'radial-gradient(120% 90% at 0% 0%, #ffffff 0%, #f4f2fb 55%, #e6e2f5 100%)',
    text: DARK_TEXT,
    textMuted: 'rgba(27, 23, 48, 0.72)',
    textSubtle: 'rgba(27, 23, 48, 0.6)',
    border: 'rgba(27, 23, 48, 0.16)',
    divider: 'rgba(27, 23, 48, 0.1)',
    hover: 'rgba(27, 23, 48, 0.06)',
    selected: 'rgba(27, 23, 48, 0.1)',
    glassBorder: 'rgba(255, 255, 255, 0.55)',
    glassHighlight: 'rgba(255, 255, 255, 0.4)',
    danger: '#d93f3f',
  },
};

const EDGE_LIGHT = 'inset 0 1px 0 rgba(255, 255, 255, 0.55), inset 0 -1px 0 rgba(255, 255, 255, 0.1)';

const FONT_FAMILY = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';

// --- Colours -------------------------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i;

const isHex = (value: string): boolean => HEX.test(value);

/** WCAG relative luminance of a `#rrggbb` colour, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const rgb = Number.parseInt(hex.slice(1), 16);
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * linear((rgb >> 16) & 255) + 0.7152 * linear((rgb >> 8) & 255) + 0.0722 * linear(rgb & 255)
  );
}

/** WCAG contrast ratio of two luminances, 1 to 21. */
function contrast(first: number, second: number): number {
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** `light` or `dark`, whichever reads better on `background`. */
function readableOn(background: string, light: string, dark: string): string {
  const base = luminance(background);
  return contrast(base, luminance(light)) >= contrast(base, luminance(dark)) ? light : dark;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** The UI scale within 90 to 150 % (spec 8.9); anything that is no number is 100 %. */
export function clampUiScale(scale: number): number {
  return clamp(scale, UI_SCALE_MIN, UI_SCALE_MAX, 1);
}

// --- Building the tokens -------------------------------------------------------------------------

/** The rainbow for "kaleido" (and for anything that is no colour), else the colour alone. */
function accentTokens(accent: string): Tokens['accent'] {
  if (!isHex(accent)) return { gradient: KALEIDO_GRADIENT, solid: KALEIDO_SOLID };
  const solid = accent.toLowerCase();
  return { gradient: `linear-gradient(90deg, ${solid}, ${solid})`, solid };
}

/**
 * The corner radii from the setting (the radius of panels and islands): items are half of it,
 * small things a third. Capsules stay capsules, unless the setting asks for square corners.
 */
function radiusTokens(large: number): Tokens['radius'] {
  return {
    s: Math.round(large * 0.3),
    m: Math.round(large * 0.5),
    l: large,
    pill: large === 0 ? 0 : 999,
  };
}

/**
 * The tokens for the appearance settings in a mode. Values the settings should not have (out of
 * range, not a number, not a colour) are held to the same ranges Rust checks, so that a bad file
 * cannot make the UI unusable. The glass opacity never goes below `GLASS_TEXT_MIN_OPACITY`.
 */
export function tokensFromAppearance(appearance: Appearance, mode: ResolvedMode): Tokens {
  const palette = PALETTE[mode];
  const defaults = DEFAULT_APPEARANCE;
  const tint = isHex(appearance.glassTint) ? appearance.glassTint.toLowerCase() : defaults.glassTint;
  const accent = accentTokens(appearance.accent);
  const onGlass = readableOn(tint, LIGHT_TEXT, DARK_TEXT);
  const lightText = onGlass === LIGHT_TEXT;
  return {
    color: {
      ...palette,
      onGlass,
      onAccent: readableOn(accent.solid, LIGHT_TEXT, ON_ACCENT_DARK),
    },
    glass: {
      tint,
      opacity: clamp(
        appearance.glassOpacity,
        GLASS_TEXT_MIN_OPACITY,
        GLASS_OPACITY_MAX,
        defaults.glassOpacity,
      ),
      blur: clamp(appearance.blur, BLUR_RANGE.min, BLUR_RANGE.max, defaults.blur),
      saturation: clamp(
        appearance.saturation,
        SATURATION_RANGE.min,
        SATURATION_RANGE.max,
        defaults.saturation,
      ),
    },
    accent,
    radius: radiusTokens(clamp(appearance.radius, RADIUS_RANGE.min, RADIUS_RANGE.max, defaults.radius)),
    font: {
      family: FONT_FAMILY,
      size: { xs: 11, s: 12, m: 13, l: 15, xl: 20, xxl: 28 },
    },
    space: { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 },
    shadow: {
      glass:
        mode === 'dark'
          ? `${EDGE_LIGHT}, 0 10px 34px rgba(0, 0, 0, 0.35)`
          : `${EDGE_LIGHT}, 0 10px 34px rgba(27, 23, 48, 0.18)`,
      popover:
        mode === 'dark' ? '0 18px 48px rgba(0, 0, 0, 0.45)' : '0 18px 48px rgba(27, 23, 48, 0.22)',
      // The shadow is the opposite of the text, so that it sets the text off.
      text: lightText ? '0 1px 2px rgba(0, 0, 0, 0.45)' : '0 1px 2px rgba(255, 255, 255, 0.5)',
    },
    motion: { fast: 150, base: 200, slow: 250, spring: 'cubic-bezier(0.34, 1.4, 0.64, 1)' },
    focus: { ring: `2px solid ${accent.solid}`, offset: 2 },
  };
}

/** The tokens of a fresh install in a mode: the defaults of the settings, with a glass that fits the mode. */
export function defaultTokens(mode: ResolvedMode): Tokens {
  return tokensFromAppearance(
    { ...DEFAULT_APPEARANCE, glassTint: mode === 'light' ? '#ffffff' : DEFAULT_APPEARANCE.glassTint },
    mode,
  );
}

// --- CSS variables -------------------------------------------------------------------------------

const PREFIX = '--k-';

const kebab = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** Numbers of these tokens are lengths in px; the durations of `motion` are ms. */
const PX_TOKENS = ['font.size.', 'radius.', 'space.', 'glass.blur', 'focus.offset'];
const MS_TOKENS = ['motion.'];

function unitOf(path: readonly string[]): string {
  const key = path.join('.');
  if (PX_TOKENS.some((prefix) => key.startsWith(prefix))) return 'px';
  if (MS_TOKENS.some((prefix) => key.startsWith(prefix))) return 'ms';
  return '';
}

interface Leaf {
  path: string[];
  value: string | number;
}

function leaves(node: object, path: string[] = []): Leaf[] {
  return Object.entries(node as Record<string, unknown>).flatMap(([name, value]) =>
    typeof value === 'object' && value !== null
      ? leaves(value, [...path, name])
      : [{ path: [...path, name], value: value as string | number }],
  );
}

/**
 * Every token as a CSS variable: `color.textMuted` is `--k-color-text-muted`, `font.size.m` is
 * `--k-font-size-m`. Lengths get `px`, durations `ms`; opacity and saturation stay numbers.
 */
export function toCssVariables(tokens: Tokens): Record<string, string> {
  return Object.fromEntries(
    leaves(tokens).map(({ path, value }) => [
      PREFIX + path.map(kebab).join('-'),
      typeof value === 'number' ? `${value}${unitOf(path)}` : value,
    ]),
  );
}

/** Writes the tokens to `element` (the root) as CSS variables. */
export function applyTokens(element: HTMLElement, tokens: Tokens): void {
  for (const [name, value] of Object.entries(toCssVariables(tokens))) {
    element.style.setProperty(name, value);
  }
}

// --- Reading the settings and Windows ------------------------------------------------------------

/** `system` follows the colour scheme of Windows, which the WebView reports as `prefers-color-scheme`. */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedMode {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

/**
 * Whether Windows gives effects that show through (glass, Mica): its transparency switch is on,
 * and no high-contrast theme, which paints with system colours, is. Rust's
 * `SystemAppearance::effects_available`.
 */
export function effectsAvailable(system: SystemAppearance): boolean {
  return system.transparencyEffects && !system.highContrast;
}

/**
 * Whether the glass is drawn opaque (and the blur shader is off): `auto` reduces transparency
 * when Windows has switched its effects off; `on` and `off` are the user's word. Rust's
 * `themes::glass_enabled` is the opposite of this, and it switches the shader by the same rule.
 */
export function resolveReduceTransparency(
  setting: ReduceTransparency,
  transparencyEffects: boolean,
): boolean {
  if (setting === 'auto') return !transparencyEffects;
  return setting === 'on';
}

/**
 * Whether the window has Mica: the switch, Windows 11, and transparency not reduced. Rust's
 * `themes::plan` applies it to the window by the same rule.
 */
export function resolveMica(
  appearance: Pick<Appearance, 'mica'>,
  system: SystemAppearance,
  reduceTransparency: boolean,
): boolean {
  return appearance.mica && system.windowsBuild >= MICA_MIN_BUILD && !reduceTransparency;
}
