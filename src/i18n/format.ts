/**
 * Times, numbers and dates for the UI (spec 8.8). Numbers and dates go through `Intl` in the
 * language the texts are in, so that Czech gets `1 234,5` and `17. 10. 2026` and English
 * `1,234.5` and `Oct 17, 2026`. A time on the seekbar is written by hand and is the same in both
 * languages: it is a clock, and its digits must not change width with the locale.
 */

import i18next from 'i18next';

import { FALLBACK_LANGUAGE } from './index';

/** The language the texts are in, English before `initI18n`. */
function currentLocale(): string {
  return i18next.isInitialized ? i18next.language : FALLBACK_LANGUAGE;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * A position or a length as a clock: `2:03`, and `1:02:03` from an hour on. A negative number, NaN
 * and infinity are `0:00`. The seconds are cut off, not rounded, so that a time never runs ahead of
 * the video. `forceHours` keeps the hours below an hour as well (`0:02:03`), so that the position
 * and the length of a film that long are written alike.
 */
export function formatTime(seconds: number, forceHours = false): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = pad(total % 60);
  return hours > 0 || forceHours ? `${hours}:${pad(minutes)}:${rest}` : `${minutes}:${rest}`;
}

/** A number in the current language: the decimal separator, the grouping of the thousands. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(currentLocale(), options).format(value);
}

/**
 * A date in the current language, `17. 10. 2026` or `Oct 17, 2026` by default. `options` choose
 * another form (`{ dateStyle: 'long', timeStyle: 'short' }`). A date that is not one is an empty
 * string rather than an error that would take the page down.
 */
export function formatDate(
  date: Date | number,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return '';
  return new Intl.DateTimeFormat(currentLocale(), options).format(value);
}
