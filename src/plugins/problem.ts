/**
 * Why a plugin change did not happen, as the UI says it. Rust rejects a plugin command with a
 * `PluginError` (`ipc/types.ts`) and in every case nothing changed. `problemOf` reads what a
 * rejected promise holds, `problemText` says it in words: the row of the plugin, the apply bar and
 * the card of a plugin that reports errors all use the same words.
 *
 * - `busy`: Apply runs; the change waits until it is done.
 * - `io`: a file could not be moved, read or written; Rust's own message says which.
 * - `notFound`: the plugin is gone (deleted from the folder meanwhile); the list is read again.
 * - `unavailable`: the player is not running, or Apply could not start a new core.
 * - `generic`: anything else, an error of the call itself and not Rust's word.
 */

import type { TFunction } from 'i18next';

export type PluginProblemCode = 'busy' | 'io' | 'notFound' | 'unavailable' | 'generic';

export interface PluginProblem {
  code: PluginProblemCode;
  /** Rust's message (for `io`, what the user reads), or the call's own error. */
  message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the rejection of a plugin command says. */
export function problemOf(error: unknown): PluginProblem {
  if (isRecord(error) && typeof error.type === 'string') {
    const message = typeof error.message === 'string' ? error.message : '';
    switch (error.type) {
      case 'busy':
        return { code: 'busy', message: '' };
      case 'unavailable':
        return { code: 'unavailable', message: '' };
      case 'notFound':
        return { code: 'notFound', message: typeof error.name === 'string' ? error.name : '' };
      case 'io':
        return { code: 'io', message };
      case 'invalid':
        // Only a setting can be invalid (Task 14); not a thing this page's commands say.
        return { code: 'generic', message: typeof error.reason === 'string' ? error.reason : '' };
    }
  }
  return { code: 'generic', message: error instanceof Error ? error.message : String(error) };
}

/** The words for `problem`. For an `io` problem they are Rust's message. */
export function problemText(problem: PluginProblem, t: TFunction): string {
  switch (problem.code) {
    case 'busy':
      return t('plugins.errors.busy');
    case 'notFound':
      return t('plugins.errors.notFound');
    case 'unavailable':
      return t('plugins.errors.unavailable');
    case 'io':
      return problem.message.trim() !== '' ? problem.message : t('plugins.errors.generic');
    case 'generic':
      return t('plugins.errors.generic');
  }
}
