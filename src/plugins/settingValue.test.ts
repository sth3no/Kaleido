import i18next from 'i18next';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import { initI18n, setLanguage } from '../i18n';
import type { SettingSpec } from '../ipc/types';
import {
  accepts,
  hasLineBreak,
  isOn,
  isValidKey,
  numberOf,
  numberText,
  stepOf,
  wantsText,
} from './settingValue';

const label = { en: 'A setting' };

const BOOL: SettingSpec = { key: 'b', type: 'bool', default: true, label };
const INT: SettingSpec = { key: 'i', type: 'int', default: 200, min: 50, max: 600, label };
const INT_FROM: SettingSpec = { key: 'i', type: 'int', default: 5, min: 1, label };
const INT_UPTO: SettingSpec = { key: 'i', type: 'int', default: 5, max: 9, label };
const INT_ANY: SettingSpec = { key: 'i', type: 'int', default: 5, label };
const FLOAT: SettingSpec = { key: 'f', type: 'float', default: 0.5, min: 0, max: 1.5, label };
const FLOAT_ANY: SettingSpec = { key: 'f', type: 'float', default: 0.5, label };
const TEXT: SettingSpec = { key: 's', type: 'string', default: 'x', label };
const ENUM: SettingSpec = { key: 'e', type: 'enum', default: 'fast', values: ['fast', 'slow'], label };
const COLOR: SettingSpec = { key: 'c', type: 'color', default: '#FFFFFF', label };
const BIG: SettingSpec = { key: 'i', type: 'int', default: 5000, min: 0, max: 10000, label };
const FRACTION: SettingSpec = { key: 'f', type: 'float', default: 0.5, min: 0.125, max: 2000.5, label };
const BELOW: SettingSpec = { key: 'f', type: 'float', default: 0, max: -0.5, label };

beforeAll(() => {
  initI18n('en');
});

afterEach(() => {
  setLanguage('en');
});

describe('accepts', () => {
  test('a bool is yes or no, and true and false are taken for them', () => {
    for (const text of ['yes', 'no', 'true', 'false']) expect(accepts(BOOL, text), text).toBe(true);
    for (const text of ['', 'Yes', '1', 'on', ' yes']) expect(accepts(BOOL, text), text).toBe(false);
  });

  test('an int is a whole number within its bounds, both inclusive', () => {
    for (const text of ['50', '200', '600', '+70', '0300']) expect(accepts(INT, text), text).toBe(true);
    for (const text of ['49', '601', '1.5', '', ' 70', '70 ', '7e2', '0x80', 'abc', '--7']) {
      expect(accepts(INT, text), text).toBe(false);
    }
    // One bound, or none.
    expect(accepts(INT_FROM, '1')).toBe(true);
    expect(accepts(INT_FROM, '0')).toBe(false);
    expect(accepts(INT_FROM, '99999999')).toBe(true);
    expect(accepts(INT_UPTO, '-5')).toBe(true);
    expect(accepts(INT_UPTO, '10')).toBe(false);
    expect(accepts(INT_ANY, '-12')).toBe(true);
  });

  test('a float is a finite number within its bounds, written as Rust reads it', () => {
    for (const text of ['0', '1.5', '.5', '1e0', '+0.25', '1.50', '1E-1']) {
      expect(accepts(FLOAT, text), text).toBe(true);
    }
    // Out of the bounds.
    for (const text of ['-0.1', '1.51', '5.', '1e3']) expect(accepts(FLOAT, text), text).toBe(false);
    // Not numbers for Rust: Number() would take some of them.
    for (const text of ['', ' 1', '0x10', 'inf', 'NaN', 'Infinity', '1e999', '1,5', '1_0']) {
      expect(accepts(FLOAT_ANY, text), text).toBe(false);
    }
    expect(accepts(FLOAT_ANY, '5.')).toBe(true);
    expect(accepts(FLOAT_ANY, '1e300')).toBe(true);
  });

  test('a string is anything in one line, an enum one of its values, a color #RRGGBB or #AARRGGBB', () => {
    expect(accepts(TEXT, '')).toBe(true);
    expect(accepts(TEXT, '  spaces count ')).toBe(true);
    expect(accepts(ENUM, 'slow')).toBe(true);
    expect(accepts(ENUM, 'Slow')).toBe(false);
    expect(accepts(ENUM, '')).toBe(false);
    for (const text of ['#FFFFFF', '#80000000', '#abcdef']) expect(accepts(COLOR, text), text).toBe(true);
    for (const text of ['', 'FFFFFF', '#FFF', '#FFFFFFF', '#GGGGGG', ' #FFFFFF']) {
      expect(accepts(COLOR, text), text).toBe(false);
    }
  });

  test('a line break is refused whatever the type', () => {
    for (const spec of [TEXT, ENUM, COLOR, INT, FLOAT, BOOL]) {
      expect(accepts(spec, `${spec.default}\nmore`), spec.type).toBe(false);
      expect(accepts(spec, `${spec.default}\r`), spec.type).toBe(false);
    }
    expect(accepts(TEXT, 'one\ntwo')).toBe(false);
    expect(hasLineBreak('one\ntwo')).toBe(true);
    expect(hasLineBreak('one line')).toBe(false);
  });
});

describe('isValidKey', () => {
  test('a key is letters, digits, underscores and hyphens', () => {
    for (const key of ['max_height', 'Max-Height', 'a', '7', '_-']) expect(isValidKey(key), key).toBe(true);
    for (const key of ['', 'two words', 'a=b', 'a.b', 'ž', ' a', 'a\n', '#a', 'a b=c']) {
      expect(isValidKey(key), JSON.stringify(key)).toBe(false);
    }
  });
});

describe('wantsText', () => {
  const { t } = i18next;

  test('says what the field takes, with the bounds', () => {
    expect(wantsText(INT, t)).toBe('Use a whole number from 50 to 600.');
    expect(wantsText(INT_FROM, t)).toBe('Use a whole number, 1 or more.');
    expect(wantsText(INT_UPTO, t)).toBe('Use a whole number, 9 or less.');
    expect(wantsText(INT_ANY, t)).toBe('Use a whole number.');
    expect(wantsText(FLOAT, t)).toBe('Use a number from 0 to 1.5.');
    expect(wantsText(FLOAT_ANY, t)).toBe('Use a number.');
    expect(wantsText(BOOL, t)).toBe('Use yes or no.');
    expect(wantsText(TEXT, t)).toBe('Use one line, with no line break.');
    expect(wantsText(ENUM, t)).toBe('Choose one of: fast, slow.');
    expect(wantsText(COLOR, t)).toBe('Use #RRGGBB or #AARRGGBB.');
  });

  test('writes the numbers in the language of the UI', () => {
    setLanguage('cs');
    expect(wantsText(FLOAT, i18next.t)).toBe('Zadej číslo od 0 do 1,5.');
    expect(wantsText(INT, i18next.t)).toBe('Zadej celé číslo od 50 do 600.');
  });

  test('writes the bounds as plain numbers, every digit, with no grouping', () => {
    expect(wantsText(BIG, i18next.t)).toBe('Use a whole number from 0 to 10000.');
    expect(wantsText(FRACTION, i18next.t)).toBe('Use a number from 0.125 to 2000.5.');
    expect(wantsText(BELOW, i18next.t)).toBe('Use a number, -0.5 or less.');
    setLanguage('cs');
    expect(wantsText(BIG, i18next.t)).toBe('Zadej celé číslo od 0 do 10000.');
    expect(wantsText(FRACTION, i18next.t)).toBe('Zadej číslo od 0,125 do 2000,5.');
    expect(wantsText(BELOW, i18next.t)).toBe('Zadej číslo, nejvýše -0,5.');
  });

  test('what the sentence says is what the field takes, in both languages', () => {
    // The field reads a comma as the point, so the Czech bounds can be typed as they are written.
    expect(accepts(FRACTION, numberText('0,125'))).toBe(true);
    expect(accepts(FRACTION, numberText('2000,5'))).toBe(true);
    expect(accepts(FRACTION, numberText('0.125'))).toBe(true);
    expect(accepts(BIG, numberText('10000'))).toBe(true);
    expect(accepts(BELOW, numberText('-0,5'))).toBe(true);
  });
});

describe('numberText', () => {
  test('a decimal comma is a point, and spaces round the number go', () => {
    expect(numberText('0,5')).toBe('0.5');
    expect(numberText(' 1,5 ')).toBe('1.5');
    expect(numberText(',5')).toBe('.5');
    expect(numberText('2.5')).toBe('2.5');
    expect(numberText('7')).toBe('7');
  });

  test('a space or a second separator is no part of a number', () => {
    for (const typed of ['1 000', '1 000,5', '1,000,5', '1.000,5', '1,5,', '1,,5']) {
      expect(accepts(FLOAT, numberText(typed)), typed).toBe(false);
      expect(accepts(FLOAT_ANY, numberText(typed)), typed).toBe(false);
    }
    // A whole number has no decimal comma at all.
    expect(accepts(INT, numberText('70,5'))).toBe(false);
    expect(accepts(INT, numberText('1,000'))).toBe(false);
    // One comma between digits is the decimal mark, as in Czech: 1,000 is one.
    expect(accepts(FLOAT_ANY, numberText('1,000'))).toBe(true);
  });
});

describe('what a stored text is', () => {
  test('numberOf reads a number, else the fallback', () => {
    expect(numberOf('300', 200)).toBe(300);
    expect(numberOf('0.25', 1)).toBe(0.25);
    expect(numberOf(undefined, 200)).toBe(200);
    expect(numberOf('abc', 200)).toBe(200);
    expect(numberOf('', 200)).toBe(200);
  });

  test('isOn is yes (or true), else the default where nothing is stored', () => {
    expect(isOn('yes', false)).toBe(true);
    expect(isOn('true', false)).toBe(true);
    expect(isOn('no', true)).toBe(false);
    expect(isOn('maybe', true)).toBe(false);
    expect(isOn(undefined, true)).toBe(true);
    expect(isOn(undefined, false)).toBe(false);
  });

  test('stepOf gives a whole number 1 and a float a hundredth of the range, in tens', () => {
    expect(stepOf('int', 50, 600)).toBe(1);
    expect(stepOf('float', 0, 1)).toBe(0.01);
    expect(stepOf('float', 0, 1.5)).toBe(0.01);
    expect(stepOf('float', 0, 100)).toBe(1);
    expect(stepOf('float', 0, 0.3)).toBe(0.001);
    expect(stepOf('float', 1, 1)).toBe(0.01);
  });
});
