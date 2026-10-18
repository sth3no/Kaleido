/**
 * Searching the settings (spec 8.10). A setting is found by its label, its keywords and the name of
 * its section, all as the current language has them, ignoring case and diacritics: "pismo" finds
 * "Písmo titulků". Every word of the query has to occur somewhere in the setting's texts.
 */

import type { TFunction } from 'i18next';

import { DESCRIPTORS, type SettingDescriptor } from './descriptors';

/** Lower case, with accents taken off (NFD, then the combining marks go): `Písmo` is `pismo`. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** The words of a comma-separated list of keywords. */
function keywordsOf(text: string): string[] {
  return text
    .split(',')
    .map((word) => word.trim())
    .filter((word) => word !== '');
}

/** Everything a setting can be found by, normalised and in one string (the space keeps words apart). */
function haystackOf(descriptor: SettingDescriptor, t: TFunction): string {
  const texts = [t(descriptor.labelKey), t(`settings.sections.${descriptor.section}`)];
  if (descriptor.keywordsKey !== undefined) texts.push(...keywordsOf(t(descriptor.keywordsKey)));
  return normalizeText(texts.join(' '));
}

/**
 * The settings that match `query`, in the order of the list. A query with no words finds none: the
 * page shows its sections then. `t` is the translation function of the language the page is in.
 */
export function searchSettings(query: string, t: TFunction): SettingDescriptor[] {
  const words = normalizeText(query).split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [];
  return DESCRIPTORS.filter((descriptor) => {
    const haystack = haystackOf(descriptor, t);
    return words.every((word) => haystack.includes(word));
  });
}
