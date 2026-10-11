export type KeyInput = {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  altGraph?: boolean;
};

const NAMED: Record<string, string> = {
  ' ': 'SPACE', Enter: 'ENTER', Escape: 'ESC', Tab: 'TAB', Backspace: 'BS', Delete: 'DEL', Insert: 'INS',
  Home: 'HOME', End: 'END', PageUp: 'PGUP', PageDown: 'PGDWN',
  ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', ArrowUp: 'UP', ArrowDown: 'DOWN',
  PrintScreen: 'PRINT', ContextMenu: 'MENU',
  MediaPlayPause: 'PLAYPAUSE', MediaStop: 'STOP', MediaTrackNext: 'NEXT', MediaTrackPrevious: 'PREV',
  AudioVolumeUp: 'VOLUME_UP', AudioVolumeDown: 'VOLUME_DOWN', AudioVolumeMute: 'MUTE',
};

const NUMPAD: Record<string, string> = {
  NumpadDecimal: 'KP_DEC', NumpadEnter: 'KP_ENTER', NumpadAdd: 'KP_ADD',
  NumpadSubtract: 'KP_SUBTRACT', NumpadMultiply: 'KP_MULTIPLY', NumpadDivide: 'KP_DIVIDE',
};

const SYMBOLS: Record<string, string> = { '#': 'SHARP' };

const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn']);

/** DOM keyboard event → mpv input.conf key name; null when mpv should not get it (spec 5.3). */
export function toMpvKey(e: KeyInput): string | null {
  if (MODIFIERS.has(e.key)) return null;
  let base: string | null = null;
  let printable = false;
  if (/^Numpad\d$/.test(e.code) && /^\d$/.test(e.key)) base = `KP${e.code.slice(6)}`;
  else if (NUMPAD[e.code]) base = NUMPAD[e.code];
  else if (NAMED[e.key]) base = NAMED[e.key];
  else if (/^F([1-9]|1\d|2[0-4])$/.test(e.key)) base = e.key;
  else if ([...e.key].length === 1) {
    base = SYMBOLS[e.key] ?? e.key;
    printable = true;
  }
  if (!base) return null;
  // AltGr arrives as Ctrl+Alt on Windows; the produced character already reflects it.
  const altGr = e.altGraph === true;
  let mods = '';
  if (e.ctrlKey && !altGr) mods += 'Ctrl+';
  if (e.altKey && !altGr) mods += 'Alt+';
  // For printable keys Shift is already in the character ("?" not "Shift+/").
  if (e.shiftKey && !printable) mods += 'Shift+';
  if (e.metaKey) mods += 'Meta+';
  return mods + base;
}
