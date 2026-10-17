import { describe, expect, it } from 'vitest';
import { toMpvKey, type KeyInput } from './keys';

const k = (key: string, o: Partial<KeyInput> = {}): KeyInput => ({
  key,
  code: '',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...o,
});

describe('toMpvKey', () => {
  it.each([
    [k(' '), 'SPACE'],
    [k(' ', { shiftKey: true }), 'Shift+SPACE'],
    [k('a'), 'a'],
    [k('A', { shiftKey: true }), 'A'],
    [k('a', { ctrlKey: true }), 'Ctrl+a'],
    [k('A', { ctrlKey: true, shiftKey: true }), 'Ctrl+A'],
    [k('ArrowLeft', { shiftKey: true }), 'Shift+LEFT'],
    [k('#', { shiftKey: true }), 'SHARP'],
    [k('?', { shiftKey: true }), '?'],
    [k('ě'), 'ě'],
    [k('€', { ctrlKey: true, altKey: true, altGraph: true }), '€'],
    [k('+', { code: 'NumpadAdd' }), 'KP_ADD'],
    [k('7', { code: 'Numpad7' }), 'KP7'],
    [k('F5'), 'F5'],
    [k('Escape'), 'ESC'],
    [k('MediaPlayPause'), 'PLAYPAUSE'],
  ])('%o → %s', (input, expected) => expect(toMpvKey(input)).toBe(expected));

  it.each(['Control', 'Shift', 'AltGraph', 'Dead', 'Unidentified'])('ignores %s', (key) =>
    expect(toMpvKey(k(key))).toBeNull(),
  );
});
