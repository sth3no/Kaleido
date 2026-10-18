/**
 * How a setting's stored value becomes the value of its field and back. An mpv option is always a
 * string (or `null` where mpv.conf does not set it): a field works with a boolean, a number, a
 * string or a list, and `decodeMpv` and `encodeMpv` translate. A value of Kaleido's own settings is
 * JSON and passes through. `''` is the field's "not set": it is sent as `null`, which takes the
 * option out of mpv.conf and puts mpv's default back.
 */

import type { FieldKind } from './descriptors';

/** What a field edits. */
export type FieldValue = boolean | number | string | readonly string[];

export const asBoolean = (value: FieldValue): boolean => value === true;
export const asNumber = (value: FieldValue, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
export const asString = (value: FieldValue): string => (typeof value === 'string' ? value : '');
export const asList = (value: FieldValue): readonly string[] => (Array.isArray(value) ? value : []);

// --- glsl-shaders ----------------------------------------------------------------------------------

/** How `glsl-shaders` names a file of the shaders folder (`~~` is mpv's config folder). */
export const SHADERS_PREFIX = '~~/shaders/';

/** mpv's separator of a list of paths on Windows. */
export const SHADERS_SEPARATOR = ';';

/** The file names in a `glsl-shaders` value, in its order; the prefix is optional (Rust accepts bare names too). */
export function parseShaders(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw === '') return [];
  return raw
    .split(SHADERS_SEPARATOR)
    .filter((entry) => entry !== '')
    .map((entry) => (entry.startsWith(SHADERS_PREFIX) ? entry.slice(SHADERS_PREFIX.length) : entry));
}

/** The `glsl-shaders` value for these files: `~~/shaders/<name>` entries joined by `;`, `null` for none. */
export function formatShaders(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return names.map((name) => `${SHADERS_PREFIX}${name}`).join(SHADERS_SEPARATOR);
}

// --- mpv options -----------------------------------------------------------------------------------

export function decodeMpv(field: FieldKind, raw: string | null | undefined): FieldValue {
  const text = raw ?? '';
  switch (field.kind) {
    case 'toggle':
      // On is any word but the off one: `autocreate-playlist` has `filter` and `same` for it.
      return text !== '' && text !== (field.off ?? 'no');
    case 'slider': {
      const number = Number(text);
      return text !== '' && Number.isFinite(number) ? number : field.min;
    }
    case 'shaderList':
      return parseShaders(raw);
    default:
      return text;
  }
}

/** What goes to `settings_set_mpv`: `null` takes the option out of mpv.conf. */
export function encodeMpv(field: FieldKind, value: FieldValue): string | null {
  switch (field.kind) {
    case 'toggle':
      return asBoolean(value) ? (field.on ?? 'yes') : (field.off ?? 'no');
    case 'slider':
      return String(asNumber(value, field.min));
    case 'shaderList':
      return formatShaders(asList(value));
    default: {
      const text = asString(value);
      return text === '' ? null : text;
    }
  }
}

// --- Kaleido's settings ----------------------------------------------------------------------------

export function decodeKaleido(field: FieldKind, raw: unknown): FieldValue {
  switch (field.kind) {
    case 'toggle':
      return raw === true;
    case 'slider':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : field.min;
    case 'shaderList':
      return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === 'string') : [];
    default:
      return typeof raw === 'string' ? raw : '';
  }
}

// --- Text fields -----------------------------------------------------------------------------------

/** Decimal places a slider's step has (`0.5` has one), to keep float noise out of the value. */
export function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** `value` held to `min`..`max` and to the decimals of `step`. */
export function cleanNumber(value: number, min: number, max: number, step: number): number {
  const held = Math.min(max, Math.max(min, value));
  return Number(held.toFixed(decimalsOf(step)));
}

/**
 * A colour as mpv writes it: `#RRGGBB` or `#AARRGGBB`, in capitals. A missing `#` is added; text
 * that is no colour is left as typed (Rust refuses it and the field says why).
 */
export function normalizeColor(text: string): string {
  const typed = text.trim();
  const bare = typed.startsWith('#') ? typed.slice(1) : typed;
  return /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(bare) ? `#${bare.toUpperCase()}` : typed;
}

/** A colour of mpv's (`#AARRGGBB`, alpha first) as CSS (`#RRGGBBAA`); `undefined` for what is no colour. */
export function cssColor(text: string): string | undefined {
  const match = /^#(?:([0-9a-f]{2}))?([0-9a-f]{6})$/i.exec(text);
  if (match === null) return undefined;
  return `#${match[2] ?? ''}${match[1] ?? ''}`;
}

/** Language codes as mpv takes them: lower case, one comma between. `cs; EN  de` is `cs,en,de`. */
export function normalizeLanguages(text: string): string {
  return text
    .split(/[\s,;]+/)
    .filter((code) => code !== '')
    .map((code) => code.toLowerCase())
    .join(',');
}
