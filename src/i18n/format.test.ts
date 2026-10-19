import { describe, expect, test } from 'vitest';

import { formatDate, formatNumber, formatRelativeTime, formatTime } from './format';
import { initI18n, setLanguage } from './index';

/** Intl separates with no-break and narrow no-break spaces (both are `\s`); the tests write a plain one. */
const plain = (text: string): string => text.replace(/\s/g, ' ');

describe('before i18n starts', () => {
  // The first tests of this file: nothing has called initI18n yet.
  test('numbers and dates are English', () => {
    expect(formatNumber(1234567.891)).toBe('1,234,567.891');
    expect(plain(formatDate(new Date(2026, 9, 17, 12), { dateStyle: 'long' }))).toBe('October 17, 2026');
  });
});

describe('formatTime', () => {
  test('pads minutes and seconds', () => {
    expect(formatTime(123)).toBe('2:03');
    expect(formatTime(3723)).toBe('1:02:03');
  });

  // The cases of the prototype's formatTime, which this one replaces.
  test.each([
    [0, '0:00'],
    [75.4, '1:15'],
    [3725, '1:02:05'],
    [Number.NaN, '0:00'],
    [-3, '0:00'],
  ])('%s → %s (from the prototype)', (seconds, text) => {
    expect(formatTime(seconds)).toBe(text);
  });

  test.each([
    [9, '0:09'],
    [59, '0:59'],
    [60, '1:00'],
    [600, '10:00'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [36000, '10:00:00'],
    [360000, '100:00:00'],
  ])('%s → %s', (seconds, text) => {
    expect(formatTime(seconds)).toBe(text);
  });

  test('the seconds are cut off, never rounded up', () => {
    expect(formatTime(0.9)).toBe('0:00');
    expect(formatTime(59.999)).toBe('0:59');
    expect(formatTime(3599.9)).toBe('59:59');
  });

  test('a negative number, NaN and infinity are 0:00', () => {
    for (const seconds of [-0.5, -1, -3600, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(formatTime(seconds), String(seconds)).toBe('0:00');
    }
  });

  test('forceHours keeps the hours below an hour', () => {
    expect(formatTime(123, true)).toBe('0:02:03');
    expect(formatTime(0, true)).toBe('0:00:00');
    expect(formatTime(3723, true)).toBe('1:02:03');
    expect(formatTime(Number.NaN, true)).toBe('0:00:00');
    expect(formatTime(-5, true)).toBe('0:00:00');
    expect(formatTime(123, false)).toBe('2:03');
  });

  test('is the same in both languages', () => {
    initI18n('cs');
    const czech = [formatTime(123), formatTime(3723), formatTime(123, true)];
    setLanguage('en');
    expect([formatTime(123), formatTime(3723), formatTime(123, true)]).toEqual(czech);
  });
});

describe('formatNumber', () => {
  test('groups and separates by the language', () => {
    setLanguage('cs');
    expect(plain(formatNumber(1234567.891))).toBe('1 234 567,891');
    setLanguage('en');
    expect(formatNumber(1234567.891)).toBe('1,234,567.891');
  });

  test('takes the options of Intl', () => {
    setLanguage('cs');
    expect(plain(formatNumber(1234567.5678, { maximumFractionDigits: 1 }))).toBe('1 234 567,6');
    expect(plain(formatNumber(0.256, { style: 'percent' }))).toBe('26 %');
    setLanguage('en');
    expect(formatNumber(1234567.5678, { maximumFractionDigits: 1 })).toBe('1,234,567.6');
    expect(formatNumber(0.256, { style: 'percent' })).toBe('26%');
  });
});

describe('formatDate', () => {
  // A local time at noon, so that no time zone moves it to another day.
  const day = new Date(2026, 9, 17, 12, 0, 0);

  test('writes the month in the language', () => {
    const long: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' };
    setLanguage('cs');
    expect(plain(formatDate(day, long))).toBe('17. října 2026');
    setLanguage('en');
    expect(plain(formatDate(day, long))).toBe('October 17, 2026');
  });

  test('is a medium date by default, in the current language', () => {
    setLanguage('cs');
    const czech = formatDate(day);
    setLanguage('en');
    const english = formatDate(day);

    expect(czech).toContain('2026');
    expect(english).toContain('2026');
    expect(czech).not.toBe(english);
  });

  test('takes a number of milliseconds as well as a Date', () => {
    setLanguage('en');
    expect(formatDate(day.getTime(), { dateStyle: 'long' })).toBe(formatDate(day, { dateStyle: 'long' }));
  });

  test('a date that is not one is empty, not an error', () => {
    expect(formatDate(new Date(Number.NaN))).toBe('');
    expect(formatDate(Number.NaN)).toBe('');
    expect(formatDate(1e20)).toBe('');
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const before = (seconds: number): string => new Date(now - seconds * 1000).toISOString();

  test('tells how long ago in the language, from a time as Rust writes it', () => {
    setLanguage('en');
    expect(formatRelativeTime(before(3 * 3600), now)).toBe('3 hours ago');
    expect(formatRelativeTime(before(5 * 60), now)).toBe('5 minutes ago');
    expect(formatRelativeTime(before(2 * 86400), now)).toBe('2 days ago');
    expect(formatRelativeTime(before(86400), now)).toBe('yesterday');
    setLanguage('cs');
    const czech = formatRelativeTime(before(3 * 3600), now);
    expect(czech).toContain('před');
    expect(czech).toContain('3');
    setLanguage('en');
  });

  test('keeps to the biggest unit it fills, cut off and not rounded up', () => {
    setLanguage('en');
    // 119 minutes are one hour and not yet two.
    expect(formatRelativeTime(before(119 * 60), now)).toBe('1 hour ago');
    expect(formatRelativeTime(before(13 * 86400), now)).toBe('last week');
    expect(formatRelativeTime(before(400 * 86400), now)).toBe('last year');
  });

  test('under a minute, and a time ahead of now, are now', () => {
    setLanguage('en');
    expect(formatRelativeTime(before(0), now)).toBe('now');
    expect(formatRelativeTime(before(59), now)).toBe('now');
    // The clock of the other side is a little ahead.
    expect(formatRelativeTime(before(-30), now)).toBe('now');
    expect(formatRelativeTime(before(-3 * 3600), now)).toBe('now');
  });

  test('takes a Date and a number of milliseconds too, and a time that is none is empty', () => {
    setLanguage('en');
    expect(formatRelativeTime(new Date(now - 2 * 3600 * 1000), now)).toBe('2 hours ago');
    expect(formatRelativeTime(now - 2 * 3600 * 1000, now)).toBe('2 hours ago');
    expect(formatRelativeTime('not a time', now)).toBe('');
    expect(formatRelativeTime(Number.NaN, now)).toBe('');
  });
});
