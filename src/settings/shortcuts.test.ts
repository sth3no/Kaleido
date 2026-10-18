import { describe, expect, test } from 'vitest';

import type { Binding, BindingSource } from '../ipc/types';
import {
  displayCommand,
  filterBindings,
  groupBindings,
  isSilenced,
  readCapture,
  sameKey,
} from './shortcuts';

const binding = (
  key: string,
  command: string,
  source: BindingSource = { type: 'kaleido' },
  comment: string | null = null,
): Binding => ({ key, command, source, comment });

/** A keydown, as the page gets it. */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, code: '', ...init });
}

describe('isSilenced', () => {
  test('a key whose command is ignore does nothing, however it is spaced', () => {
    expect(isSilenced(binding('q', 'ignore', { type: 'user' }))).toBe(true);
    expect(isSilenced(binding('q', ' ignore ', { type: 'user' }))).toBe(true);
    expect(isSilenced(binding('q', 'quit'))).toBe(false);
    // A command that merely mentions it is a command.
    expect(isSilenced(binding('q', 'no-osd ignore'))).toBe(false);
  });
});

describe('displayCommand', () => {
  test('leaves out the prefix mpv puts in front of a script\'s binding', () => {
    // As mpv lists a script's own binding.
    expect(displayCommand('nonscalable script-binding testbind/test-x')).toBe(
      'script-binding testbind/test-x',
    );
    expect(displayCommand('  nonscalable   script-binding stats/display-stats  ')).toBe(
      'script-binding stats/display-stats',
    );
  });

  test('keeps what the author of a line wrote, and the inside of the rest, as they are', () => {
    expect(displayCommand('cycle pause')).toBe('cycle pause');
    // Kaleido's own lines say no-osd themselves.
    expect(displayCommand('no-osd seek 5; script-message kaleido osd seek')).toBe(
      'no-osd seek 5; script-message kaleido osd seek',
    );
    expect(displayCommand('nonscalable show-text "a  b"')).toBe('show-text "a  b"');
    // A word that only starts like the prefix is the command.
    expect(displayCommand('nonscalablex thing')).toBe('nonscalablex thing');
    // A prefix with nothing after it is all there is to show.
    expect(displayCommand('nonscalable')).toBe('nonscalable');
  });
});

describe('sameKey', () => {
  test('is the same key whatever the order and the case of the modifiers', () => {
    expect(sameKey('Ctrl+f', 'Ctrl+f')).toBe(true);
    expect(sameKey('Ctrl+Shift+x', 'shift+ctrl+x')).toBe(true);
    expect(sameKey('Ctrl+Alt+RIGHT', 'alt+ctrl+Right')).toBe(true);
  });

  test('a named key is not case sensitive, a character is', () => {
    expect(sameKey('RIGHT', 'Right')).toBe(true);
    expect(sameKey('Ctrl+SPACE', 'ctrl+space')).toBe(true);
    // a and A are two keys in mpv.
    expect(sameKey('a', 'A')).toBe(false);
    expect(sameKey('Ctrl+a', 'Ctrl+A')).toBe(false);
  });

  test('is another key when the modifiers or the key differ', () => {
    expect(sameKey('f', 'Ctrl+f')).toBe(false);
    expect(sameKey('Ctrl+f', 'Alt+f')).toBe(false);
    expect(sameKey('Ctrl+f', 'Ctrl+g')).toBe(false);
    expect(sameKey('Ctrl+Shift+f', 'Ctrl+f')).toBe(false);
  });

  test('the plus key is told from the separator', () => {
    expect(sameKey('+', '+')).toBe(true);
    expect(sameKey('Ctrl++', 'ctrl++')).toBe(true);
    expect(sameKey('Ctrl++', 'Ctrl+f')).toBe(false);
    expect(sameKey('+', 'Ctrl++')).toBe(false);
    expect(sameKey('Shift++', 'Ctrl++')).toBe(false);
  });
});

describe('groupBindings', () => {
  const all = [
    binding('i', 'script-binding stats/display-stats', { type: 'plugin', name: 'stats' }),
    binding('f', 'cycle fullscreen', { type: 'mpv' }),
    binding('Ctrl+h', 'script-binding thumbfast/toggle', { type: 'plugin', name: 'thumbfast' }),
    binding('Ctrl+f', 'cycle fullscreen', { type: 'user' }, 'My fullscreen'),
    binding('RIGHT', 'no-osd seek 5'),
    binding('d', 'cycle deband', { type: 'mpv' }),
    binding('x', 'script-binding another/run', { type: 'plugin', name: 'another' }),
    binding('LEFT', 'no-osd seek -5'),
  ];

  test('puts Kaleido first, then the user, mpv and the plugins by name', () => {
    expect(groupBindings(all).map((group) => group.id)).toEqual([
      'kaleido',
      'user',
      'mpv',
      'plugin:another',
      'plugin:stats',
      'plugin:thumbfast',
    ]);
  });

  test('keeps the order of mpv inside a group', () => {
    const groups = groupBindings(all);
    expect(groups[0]?.bindings.map((entry) => entry.key)).toEqual(['RIGHT', 'LEFT']);
    expect(groups[2]?.bindings.map((entry) => entry.key)).toEqual(['f', 'd']);
  });

  test('leaves out a group with nothing in it, and has no group for no bindings', () => {
    expect(groupBindings([binding('f', 'x', { type: 'mpv' })]).map((group) => group.id)).toEqual(['mpv']);
    expect(groupBindings([])).toEqual([]);
  });

  test('a plugin keeps its name for the heading', () => {
    expect(groupBindings(all).find((group) => group.id === 'plugin:stats')?.source).toEqual({
      type: 'plugin',
      name: 'stats',
    });
  });
});

describe('filterBindings', () => {
  const label = (source: BindingSource) => (source.type === 'plugin' ? source.name : source.type);
  const all = [
    binding('RIGHT', 'no-osd seek 5; script-message kaleido osd seek'),
    binding('Ctrl+f', 'cycle fullscreen', { type: 'user' }, 'Můj celá obrazovka'),
    binding('i', 'script-binding stats/display-stats', { type: 'plugin', name: 'stats' }),
    binding('f', 'cycle fullscreen', { type: 'mpv' }),
  ];
  const keys = (found: Binding[]) => found.map((entry) => entry.key);

  test('no words match everything', () => {
    expect(keys(filterBindings(all, '', label))).toEqual(['RIGHT', 'Ctrl+f', 'i', 'f']);
    expect(keys(filterBindings(all, '   ', label))).toEqual(['RIGHT', 'Ctrl+f', 'i', 'f']);
  });

  test('finds by the key, the command, the description and the group, ignoring case and accents', () => {
    expect(keys(filterBindings(all, 'ctrl+f', label))).toEqual(['Ctrl+f']);
    expect(keys(filterBindings(all, 'FULLSCREEN', label))).toEqual(['Ctrl+f', 'f']);
    expect(keys(filterBindings(all, 'obrazovka', label))).toEqual(['Ctrl+f']);
    expect(keys(filterBindings(all, 'stats', label))).toEqual(['i']);
    expect(keys(filterBindings(all, 'user', label))).toEqual(['Ctrl+f']);
  });

  test('every word has to occur, in any order', () => {
    expect(keys(filterBindings(all, 'fullscreen mpv', label))).toEqual(['f']);
    expect(keys(filterBindings(all, 'mpv fullscreen', label))).toEqual(['f']);
    expect(filterBindings(all, 'fullscreen stats', label)).toEqual([]);
  });

  test('searches the command as the page shows it, without the prefix mpv put in front', () => {
    // mpv lists a plugin's key as `nonscalable script-binding …`; the page shows no "nonscalable",
    // so a search for it must not find every plugin row.
    const plugins = [
      ...all,
      binding('x', 'nonscalable script-binding testbind/test-x', { type: 'plugin', name: 'testbind' }),
      binding('y', 'nonscalable script-binding testbind/test-y', { type: 'plugin', name: 'testbind' }),
    ];
    expect(filterBindings(plugins, 'nonscalable', label)).toEqual([]);
    expect(keys(filterBindings(plugins, 'script-binding testbind/test-x', label))).toEqual(['x']);
    expect(keys(filterBindings(plugins, 'testbind', label))).toEqual(['x', 'y']);
  });
});

describe('readCapture', () => {
  test('a key is named the way mpv names it', () => {
    expect(readCapture(press('x', { code: 'KeyX' }))).toEqual({ type: 'key', key: 'x' });
    expect(readCapture(press('f', { ctrlKey: true }))).toEqual({ type: 'key', key: 'Ctrl+f' });
    expect(readCapture(press('ArrowRight', { shiftKey: true }))).toEqual({
      type: 'key',
      key: 'Shift+RIGHT',
    });
    expect(readCapture(press(' '))).toEqual({ type: 'key', key: 'SPACE' });
    expect(readCapture(press('F5'))).toEqual({ type: 'key', key: 'F5' });
  });

  test('Esc on its own cancels, Esc with a modifier is a key', () => {
    expect(readCapture(press('Escape'))).toEqual({ type: 'cancel' });
    expect(readCapture(press('Escape', { ctrlKey: true }))).toEqual({ type: 'key', key: 'Ctrl+ESC' });
    expect(readCapture(press('Escape', { shiftKey: true }))).toEqual({ type: 'key', key: 'Shift+ESC' });
  });

  test('a modifier on its own, or a key mpv has no name for, is not an answer yet', () => {
    for (const modifier of ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']) {
      expect(readCapture(press(modifier, { ctrlKey: modifier === 'Control' })), modifier).toEqual({
        type: 'wait',
      });
    }
    expect(readCapture(press('Dead'))).toEqual({ type: 'wait' });
    expect(readCapture(press('Unidentified'))).toEqual({ type: 'wait' });
  });

  test('a key that is Windows\' or moves the focus is reserved', () => {
    expect(readCapture(press('Tab'))).toEqual({ type: 'reserved' });
    expect(readCapture(press('Tab', { shiftKey: true }))).toEqual({ type: 'reserved' });
    expect(readCapture(press('a', { metaKey: true }))).toEqual({ type: 'reserved' });
    expect(readCapture(press('F4', { altKey: true }))).toEqual({ type: 'reserved' });
    // Ctrl+Tab is mpv's to bind (the UI sends it on).
    expect(readCapture(press('Tab', { ctrlKey: true }))).toEqual({ type: 'key', key: 'Ctrl+TAB' });
  });

  test('text being composed is not an answer', () => {
    expect(readCapture(press('a', { isComposing: true }))).toEqual({ type: 'wait' });
  });
});
