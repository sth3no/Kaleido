/**
 * What a plugin's setting takes, checked in the UI before Rust is asked. Rust checks every value
 * again (`plugins/schema.rs` for a schema's types, `plugins/script_opts.rs` for keys and lines), so
 * a user normally never sees Rust's English reasons; these rules say the same in the language of
 * the UI, and a value that fails them is never sent.
 *
 * - `bool` is `yes` or `no` (`true` and `false` are taken for them), `int` a whole number and
 *   `float` a finite one, both within the bounds of the spec (inclusive), `enum` one of its values,
 *   `color` `#RRGGBB` or `#AARRGGBB`, `string` anything. Whatever the type, one line.
 * - A key of the key = value editor is `[A-Za-z0-9_-]+`.
 *
 * A number is checked the way Rust reads it (`i64` and `f64` parsing: an optional sign, digits, for
 * a float a point and an exponent; no spaces, no hex, no `inf`), not the way `Number()` does.
 */

import type { TFunction } from 'i18next';

import { formatNumber } from '../i18n/format';
import type { SettingSpec } from '../ipc/types';
import { isColor } from '../settings/values';

/** What a plugin's setting is saved as, or why it was not: what every field of the forms calls. */
export interface SettingProblem {
  /** The sentence for the user, in the language of the UI. */
  text: string;
  /** Rust's own reason (English), where Rust refused the value. */
  detail?: string;
}

/**
 * Saves `key` in the plugin's `script-opts` file; `null` takes the line out (the script's default).
 * Resolves with `null` when it is saved, or with why it is not (nothing changed then).
 */
export type SaveSetting = (key: string, value: string | null) => Promise<SettingProblem | null>;

/** Whether `key` is one Kaleido writes: letters, digits, `_` and `-`, and not empty. */
export const isValidKey = (key: string): boolean => /^[A-Za-z0-9_-]+$/.test(key);

/** Whether `text` is more than one line. */
export const hasLineBreak = (text: string): boolean => /[\r\n]/.test(text);

const WHOLE = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const BOOLS = new Set(['yes', 'true', 'no', 'false']);

function inRange(value: number, min: number | undefined, max: number | undefined): boolean {
  return (min === undefined || value >= min) && (max === undefined || value <= max);
}

/** Whether `text` is a value the setting `spec` takes. */
export function accepts(spec: SettingSpec, text: string): boolean {
  if (hasLineBreak(text)) return false;
  switch (spec.type) {
    case 'bool':
      return BOOLS.has(text);
    case 'int':
      return WHOLE.test(text) && inRange(Number(text), spec.min, spec.max);
    case 'float': {
      const number = DECIMAL.test(text) ? Number(text) : Number.NaN;
      return Number.isFinite(number) && inRange(number, spec.min, spec.max);
    }
    case 'string':
      return true;
    case 'enum':
      return spec.values.includes(text);
    case 'color':
      return isColor(text);
  }
}

/** What the setting `spec` takes, as a sentence: the message under a field that holds a value it will not send. */
export function wantsText(spec: SettingSpec, t: TFunction): string {
  switch (spec.type) {
    case 'bool':
      return t('plugins.settings.wants.bool');
    case 'int':
    case 'float': {
      const family = spec.type === 'int' ? 'whole' : 'number';
      const min = spec.min === undefined ? undefined : formatNumber(spec.min);
      const max = spec.max === undefined ? undefined : formatNumber(spec.max);
      if (min !== undefined && max !== undefined) {
        return t(`plugins.settings.wants.${family}Between`, { min, max });
      }
      if (min !== undefined) return t(`plugins.settings.wants.${family}Min`, { min });
      if (max !== undefined) return t(`plugins.settings.wants.${family}Max`, { max });
      return t(`plugins.settings.wants.${family}`);
    }
    case 'string':
      return t('plugins.settings.wants.line');
    case 'enum':
      return t('plugins.settings.wants.enum', { values: spec.values.join(', ') });
    case 'color':
      return t('settings.errors.invalidColor');
  }
}

/** The number a stored text is, or `fallback` where it is none (a hand-edited file). */
export function numberOf(text: string | undefined, fallback: number): number {
  const number = text !== undefined && DECIMAL.test(text) ? Number(text) : Number.NaN;
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Whether a stored text is on. mpv's own reading of a flag is `yes` and `no` only; `true` is
 * taken for `yes` as Rust takes it when it is typed. Anything else is not on.
 */
export const isOn = (text: string | undefined, fallback: boolean): boolean =>
  text === undefined ? fallback : text === 'yes' || text === 'true';

/**
 * How far one key press moves the slider of a number: 1 for a whole number, and for a float a power
 * of ten near a hundredth of the range (0.01 for 0 to 1), so that the slider has about a hundred
 * to a thousand positions.
 */
export function stepOf(type: 'int' | 'float', min: number, max: number): number {
  if (type === 'int') return 1;
  const range = max - min;
  if (!(range > 0)) return 0.01;
  // The nudge keeps a range that is an exact power of ten from falling to the power below it; the
  // number is parsed from its text, which is the double nearest to it (`10 ** -2` need not be).
  return Number(`1e${Math.floor(Math.log10(range / 100) + 1e-9)}`);
}
