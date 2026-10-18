import { describe, expect, test } from 'vitest';

import cs from '../i18n/locales/cs.json';
import en from '../i18n/locales/en.json';
import type { FieldKind } from './descriptors';
import { errorText, isSettingsError } from './useSetting';

const SLIDER: FieldKind = { kind: 'slider', min: 0, max: 10, step: 1 };

describe('what Rust refuses with', () => {
  test('a settings error is told from a plain message', () => {
    expect(isSettingsError({ type: 'invalid', key: 'slang', reason: 'language codes' })).toBe(true);
    expect(isSettingsError({ type: 'notAllowed', key: 'vo' })).toBe(true);
    expect(isSettingsError({ type: 'io', message: 'disk full' })).toBe(true);
    expect(isSettingsError({ type: 'unavailable' })).toBe(true);
    expect(isSettingsError('command settings_set_mpv not found')).toBe(false);
    expect(isSettingsError(null)).toBe(false);
    expect(isSettingsError({ type: 'somethingElse' })).toBe(false);
    expect(isSettingsError({ kind: 'invalid' })).toBe(false);
  });

  test('every refusal has a text, and the text of a value that is no good depends on the field', () => {
    expect(errorText({ kind: 'langList' }, { type: 'invalid', key: 'slang', reason: 'x' })).toBe(
      'settings.errors.invalidLangList',
    );
    expect(errorText({ kind: 'color' }, { type: 'invalid', key: 'sub-color', reason: 'x' })).toBe(
      'settings.errors.invalidColor',
    );
    expect(errorText(SLIDER, { type: 'invalid', key: 'volume', reason: 'x' })).toBe(
      'settings.errors.invalid',
    );
    expect(errorText(SLIDER, { type: 'notAllowed', key: 'volume' })).toBe(
      'settings.errors.notAllowed',
    );
    expect(errorText(SLIDER, { type: 'io', message: 'x' })).toBe('settings.errors.io');
    expect(errorText(SLIDER, { type: 'unavailable' })).toBe('settings.errors.unavailable');
    // Tauri could not run the command at all.
    expect(errorText(SLIDER, 'invalid args')).toBe('settings.errors.generic');
    expect(errorText(SLIDER, undefined)).toBe('settings.errors.generic');
  });

  test('the texts are in both languages', () => {
    const keys = [
      'invalid',
      'invalidLangList',
      'invalidColor',
      'notAllowed',
      'io',
      'unavailable',
      'generic',
    ];
    for (const tree of [cs, en]) {
      for (const key of keys) {
        const text = (tree.settings.errors as Record<string, string>)[key];
        expect(typeof text, key).toBe('string');
        expect(text?.trim(), key).not.toBe('');
      }
    }
  });
});
