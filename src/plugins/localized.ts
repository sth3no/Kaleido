import type { Localized } from '../ipc/types';

/**
 * The text of a plugin or of its manifest in the language of the UI: Czech where it has a Czech
 * text, else English (the one every text has).
 */
export function localized(text: Localized, language: string): string {
  return language.toLowerCase().startsWith('cs') ? (text.cs ?? text.en) : text.en;
}

/** `names` as a sentence's list in the language of the UI: "reload and thumbfast". */
export function listOf(names: readonly string[], language: string): string {
  return new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(names);
}
