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

/**
 * The command prefixes mpv puts in front of a binding by itself: a script's key binding that is not
 * scalable is listed as `<key> nonscalable script-binding <script>/<name>` (mpv's defaults.lua). No
 * one wrote it, and it says how the command runs, not what it does. The prefixes of a line of
 * input.conf (`no-osd seek 5`) are what its author wrote, and are shown.
 */
const ADDED_PREFIXES: ReadonlySet<string> = new Set(['nonscalable']);

/**
 * A command as the page shows it: without the prefixes mpv added to it (`ADDED_PREFIXES`). Only the
 * text is shortened: Rust keeps the command whole, so a moved shortcut is written with its prefixes
 * and works the same on its new key. A command that is nothing but a prefix is shown as it is.
 */
export function displayCommand(command: string): string {
  let rest = command.trim();
  for (;;) {
    const match = /^(\S+)\s+/.exec(rest);
    const word = match?.[1];
    if (match === null || word === undefined || !ADDED_PREFIXES.has(word)) return rest;
    rest = rest.slice(match[0].length);
  }
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

/**
 * Keeps the key `code` (`KeyboardEvent.code`, or `key` where the engine gives no code) from the page
 * and from mpv until it is released. It ended the wait (it is the answer, or Esc), but a key held past
 * the repeat delay goes on sending keydowns, which `input/forward.ts` would pass on to mpv (with the
 * keyup after them): the key's old command would run, in a conflict even before "Replace". Its
 * keydowns and its keyup are handled (`preventDefault`) and stopped in the capture of the window,
 * before anything else sees them. The keyup ends it, and so does leaving the window (the keyup then
 * goes elsewhere). Returns the function that ends it at once.
 */
export function swallowUntilReleased(code: string): () => void {
  const abort = new AbortController();
  const { signal } = abort;
  const ours = (e: KeyboardEvent) => (e.code || e.key) === code;
  const swallow = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener(
    'keydown',
    (e) => {
      if (ours(e)) swallow(e);
    },
    { signal, capture: true },
  );
  window.addEventListener(
    'keyup',
    (e) => {
      if (!ours(e)) return;
      swallow(e);
      abort.abort();
    },
    { signal, capture: true },
  );
  window.addEventListener(
    'blur',
    () => {
      abort.abort();
    },
    { signal },
  );
  return () => {
    abort.abort();
  };
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
 * The bindings that match `query`: every word of it has to occur in the key, the command as the page
 * shows it (`displayCommand`: a prefix mpv added is not shown, so it finds nothing), the description
 * or the name of the group (as `sourceLabel` says it), ignoring case and accents. A query with no
 * words matches everything.
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
      [binding.key, displayCommand(binding.command), binding.comment ?? '', sourceLabel(binding.source)].join(' '),
    );
    return words.every((word) => haystack.includes(word));
  });
}
