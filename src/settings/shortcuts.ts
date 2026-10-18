/**
 * What the shortcuts page works out from mpv's bindings (spec 8.10), without React: which key is
 * which (two spellings of one key), the groups the list is sorted into, what the search finds, and
 * what a key press means while a shortcut is being changed.
 */

import { isFocusMove, isSystemShortcut } from '../input/forward';
import { toMpvKey } from '../input/keys';
import type { Binding, BindingSource } from '../ipc/types';
import { normalizeText } from './search';

/** What mpv's `ignore` command makes a key do. */
export const SILENCED_COMMAND = 'ignore';

/**
 * Whether the key does nothing: the user moved its binding away, or reset a key they had made up
 * (mpv cannot unbind a key at run time, so it is `ignore` until the next start). Both are told alike.
 */
export function isSilenced(binding: Binding): boolean {
  return binding.command.trim() === SILENCED_COMMAND;
}

// --- Keys -------------------------------------------------------------------------------------------

/** A key name in mpv's words, taken apart: `Ctrl+Shift+f` is `ctrl`, `shift` and `f`; `Ctrl++` ends in `+`. */
function splitKey(name: string): { modifiers: string[]; base: string } {
  const plus = name.endsWith('+');
  // The key `+` itself is the last character, so the modifiers are what stands before it.
  const base = plus ? '+' : name.slice(name.lastIndexOf('+') + 1);
  const head = plus ? name.slice(0, -1) : name.slice(0, name.length - base.length);
  const modifiers = head
    .split('+')
    .filter((modifier) => modifier !== '')
    .map((modifier) => modifier.toLowerCase())
    .sort();
  return { modifiers, base };
}

/**
 * Whether two key names are one key. The modifiers are the same in any order and any case
 * (`Ctrl+Shift+x`, `shift+ctrl+x`); a key that is a character is case sensitive (`a` and `A` are two
 * keys in mpv), the named ones (`RIGHT`, `Right`) are not.
 */
export function sameKey(first: string, second: string): boolean {
  const a = splitKey(first);
  const b = splitKey(second);
  if (a.modifiers.join('+') !== b.modifiers.join('+')) return false;
  const character = [...a.base].length === 1 && [...b.base].length === 1;
  return character ? a.base === b.base : a.base.toLowerCase() === b.base.toLowerCase();
}

/** What a key press means while the shortcut waits for its new key. */
export type Capture =
  /** Esc on its own: the change is dropped. */
  | { type: 'cancel' }
  /** Not a key yet: a modifier on its own, or a key mpv has no name for. The wait goes on. */
  | { type: 'wait' }
  /** A key that is Windows' or moves the focus (Tab): mpv never gets it, so a shortcut on it would never run. */
  | { type: 'reserved' }
  | { type: 'key'; key: string };

export function readCapture(e: KeyboardEvent): Capture {
  if (e.isComposing) return { type: 'wait' };
  if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
    return { type: 'cancel' };
  }
  const key = toMpvKey({
    key: e.key,
    code: e.code,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    metaKey: e.metaKey,
    altGraph: e.getModifierState('AltGraph'),
  });
  if (key === null) return { type: 'wait' };
  if (isSystemShortcut(e) || isFocusMove(e)) return { type: 'reserved' };
  return { type: 'key', key };
}

// --- Groups and search ------------------------------------------------------------------------------

export interface BindingGroup {
  /** `kaleido`, `user`, `mpv` or `plugin:<name>`. */
  id: string;
  source: BindingSource;
  bindings: Binding[];
}

const groupIdOf = (source: BindingSource): string =>
  source.type === 'plugin' ? `plugin:${source.name}` : source.type;

/**
 * The bindings sorted into groups by where they come from, in the order Kaleido, the user's own,
 * mpv, then the plugins by name. A group with no binding is left out; inside a group the order is mpv's.
 */
export function groupBindings(bindings: readonly Binding[]): BindingGroup[] {
  const groups = new Map<string, BindingGroup>();
  for (const binding of bindings) {
    const id = groupIdOf(binding.source);
    const group = groups.get(id) ?? { id, source: binding.source, bindings: [] };
    group.bindings.push(binding);
    groups.set(id, group);
  }
  const rank = (group: BindingGroup): number =>
    ({ kaleido: 0, user: 1, mpv: 2, plugin: 3 })[group.source.type];
  return [...groups.values()].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.id.localeCompare(b.id);
  });
}

/**
 * The bindings that match `query`: every word of it has to occur in the key, the command, the
 * description or the name of the group (as `sourceLabel` says it), ignoring case and accents. A
 * query with no words matches everything.
 */
export function filterBindings(
  bindings: readonly Binding[],
  query: string,
  sourceLabel: (source: BindingSource) => string,
): Binding[] {
  const words = normalizeText(query)
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return [...bindings];
  return bindings.filter((binding) => {
    const haystack = normalizeText(
      [binding.key, binding.command, binding.comment ?? '', sourceLabel(binding.source)].join(' '),
    );
    return words.every((word) => haystack.includes(word));
  });
}
