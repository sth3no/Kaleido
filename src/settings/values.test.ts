import { describe, expect, test } from 'vitest';

import type { FieldKind } from './descriptors';
import {
  SHADERS_PREFIX,
  cleanNumber,
  cssColor,
  decimalsOf,
  decodeKaleido,
  decodeMpv,
  encodeMpv,
  formatShaders,
  isColor,
  isLanguages,
  normalizeColor,
  normalizeLanguages,
  parseShaders,
} from './values';

const YES_NO: FieldKind = { kind: 'toggle' };
const FOLDER_PLAYLIST: FieldKind = { kind: 'toggle', on: 'filter', off: 'no' };
const SLIDER: FieldKind = { kind: 'slider', min: 10, max: 120, step: 1 };

describe('glsl-shaders', () => {
  test('the value is ~~/shaders/<name> entries joined by ;', () => {
    expect(SHADERS_PREFIX).toBe('~~/shaders/');
    expect(formatShaders(['Anime4K.glsl'])).toBe('~~/shaders/Anime4K.glsl');
    expect(formatShaders(['a.glsl', 'b.hook', 'c d.glsl'])).toBe(
      '~~/shaders/a.glsl;~~/shaders/b.hook;~~/shaders/c d.glsl',
    );
  });

  test('no shaders is null, which takes the option out of mpv.conf', () => {
    expect(formatShaders([])).toBeNull();
    expect(encodeMpv({ kind: 'shaderList' }, [])).toBeNull();
    expect(encodeMpv({ kind: 'shaderList' }, ['x.glsl'])).toBe('~~/shaders/x.glsl');
  });

  test('the names come back out of the value, in its order; a bare name is accepted too', () => {
    expect(parseShaders('~~/shaders/b.hook;~~/shaders/a.glsl')).toEqual(['b.hook', 'a.glsl']);
    expect(parseShaders('bare.glsl;~~/shaders/a.glsl')).toEqual(['bare.glsl', 'a.glsl']);
    expect(parseShaders('')).toEqual([]);
    expect(parseShaders(null)).toEqual([]);
    expect(parseShaders(undefined)).toEqual([]);
    expect(parseShaders('~~/shaders/a.glsl;;')).toEqual(['a.glsl']);
    expect(decodeMpv({ kind: 'shaderList' }, '~~/shaders/a.glsl')).toEqual(['a.glsl']);
  });

  test('what is parsed formats back to the same value', () => {
    const value = '~~/shaders/x.glsl;~~/shaders/y.hook';
    expect(formatShaders(parseShaders(value))).toBe(value);
  });
});

describe('mpv values and field values', () => {
  test('a toggle is on for any word but its off word', () => {
    expect(decodeMpv(YES_NO, 'yes')).toBe(true);
    expect(decodeMpv(YES_NO, 'no')).toBe(false);
    expect(decodeMpv(YES_NO, null)).toBe(false);
    expect(decodeMpv(FOLDER_PLAYLIST, 'filter')).toBe(true);
    // The third word of autocreate-playlist also creates one.
    expect(decodeMpv(FOLDER_PLAYLIST, 'same')).toBe(true);
    expect(decodeMpv(FOLDER_PLAYLIST, 'no')).toBe(false);
  });

  test('a toggle is saved as its words: yes and no, or filter and no for the playlist', () => {
    expect(encodeMpv(YES_NO, true)).toBe('yes');
    expect(encodeMpv(YES_NO, false)).toBe('no');
    expect(encodeMpv(FOLDER_PLAYLIST, true)).toBe('filter');
    expect(encodeMpv(FOLDER_PLAYLIST, false)).toBe('no');
  });

  test('numbers come as the text mpv gives and go as text', () => {
    expect(decodeMpv(SLIDER, '55')).toBe(55);
    expect(decodeMpv(SLIDER, '2.5')).toBe(2.5);
    // No value, or no number: the slider starts at its minimum.
    expect(decodeMpv(SLIDER, null)).toBe(10);
    expect(decodeMpv(SLIDER, '')).toBe(10);
    expect(decodeMpv(SLIDER, 'loud')).toBe(10);
    expect(encodeMpv(SLIDER, 55)).toBe('55');
    expect(encodeMpv(SLIDER, 2.5)).toBe('2.5');
  });

  test('text fields keep their text, and empty is null (taken out of mpv.conf)', () => {
    for (const kind of ['select', 'color', 'font', 'langList', 'device'] as const) {
      const field = (kind === 'select' ? { kind, options: [] } : { kind }) as FieldKind;
      expect(decodeMpv(field, 'abc'), kind).toBe('abc');
      expect(decodeMpv(field, null), kind).toBe('');
      expect(encodeMpv(field, 'abc'), kind).toBe('abc');
      expect(encodeMpv(field, ''), kind).toBeNull();
    }
  });

  test("Kaleido's own settings pass through as they are", () => {
    expect(decodeKaleido(YES_NO, true)).toBe(true);
    expect(decodeKaleido(YES_NO, 'yes')).toBe(false);
    expect(decodeKaleido(SLIDER, 40)).toBe(40);
    expect(decodeKaleido(SLIDER, undefined)).toBe(10);
    expect(decodeKaleido({ kind: 'select', options: [] }, 'append')).toBe('append');
    expect(decodeKaleido({ kind: 'select', options: [] }, undefined)).toBe('');
  });
});

describe('numbers', () => {
  test('a number is held to the range and to the decimals of the step', () => {
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(0.5)).toBe(1);
    expect(decimalsOf(0.05)).toBe(2);
    expect(cleanNumber(0.1 + 0.2, 0, 10, 0.1)).toBe(0.3);
    expect(cleanNumber(500, 0, 100, 1)).toBe(100);
    expect(cleanNumber(-3, 0, 100, 1)).toBe(0);
    expect(cleanNumber(2.5, 0, 10, 0.5)).toBe(2.5);
  });
});

describe('colours', () => {
  test('a colour is written as mpv writes it: # and capitals', () => {
    expect(normalizeColor('ff8800')).toBe('#FF8800');
    expect(normalizeColor(' #ff8800 ')).toBe('#FF8800');
    expect(normalizeColor('80ff8800')).toBe('#80FF8800');
    // Not a colour: left as typed, for Rust to refuse.
    expect(normalizeColor('red')).toBe('red');
    expect(normalizeColor('#12345')).toBe('#12345');
    expect(normalizeColor('')).toBe('');
  });

  test('mpv\'s #AARRGGBB (alpha first) is CSS #RRGGBBAA', () => {
    expect(cssColor('#FF8800')).toBe('#FF8800');
    expect(cssColor('#80FF0000')).toBe('#FF000080');
    expect(cssColor('#00000000')).toBe('#00000000');
    expect(cssColor('red')).toBeUndefined();
    expect(cssColor('#12345')).toBeUndefined();
    expect(cssColor('')).toBeUndefined();
  });
});

describe('what can be sent', () => {
  test('a colour is #RRGGBB or #AARRGGBB, and nothing else', () => {
    for (const good of ['#FFFFFF', '#ffcc00', '#80000000', '#00FFFFFF']) {
      expect(isColor(good), good).toBe(true);
    }
    for (const bad of ['red', '#12', '#12345', '#1234567', '#123456789', 'FFFFFF', '#GG0000', '', '#']) {
      expect(isColor(bad), bad).toBe(false);
    }
    // What the field makes of typed text is a colour where the text was one.
    expect(isColor(normalizeColor('ff8800'))).toBe(true);
    expect(isColor(normalizeColor('red'))).toBe(false);
  });

  test('languages are two or three letters each', () => {
    for (const good of ['cs', 'cs,en', 'eng', 'cs,en,deu']) {
      expect(isLanguages(good), good).toBe(true);
    }
    for (const bad of ['czech', 'c', 'cs,', ',cs', 'cs,e', 'cs1', 'čs', 'cs en', '']) {
      expect(isLanguages(bad), bad).toBe(false);
    }
    // What the field makes of typed text is a list where the text was one.
    expect(isLanguages(normalizeLanguages('cs; EN  de'))).toBe(true);
    expect(isLanguages(normalizeLanguages('cs czech'))).toBe(false);
  });
});

describe('languages', () => {
  test('codes are lower case, in order, with one comma between', () => {
    expect(normalizeLanguages('cs, en')).toBe('cs,en');
    expect(normalizeLanguages('cs; EN  de')).toBe('cs,en,de');
    expect(normalizeLanguages(' cs ,, en, ')).toBe('cs,en');
    expect(normalizeLanguages('')).toBe('');
    expect(normalizeLanguages('  ')).toBe('');
  });
});
