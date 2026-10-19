/**
 * What the two places that offer the browsers of `system_browsers` (the chooser on the card of a link
 * that wants cookies, and Settings → Playback → "Cookies from a browser") agree on, without React: which
 * entries cannot be chosen, the order they are listed in, and the sentence that goes with an entry.
 * One rule for both, so that a change of Rust's `BrowserWarning` is made here and nowhere else.
 */

import type { Browser } from '../../ipc/types';

/** The sentence for an entry with no profile that has cookies. */
const NO_PROFILE_NOTE = 'errors.browser.noProfile';
/** The sentence for a Chromium-based browser, whose cookies yt-dlp mostly cannot read on Windows. */
const CHROMIUM_NOTE = 'errors.browser.chromiumCookies';

/** An entry with nothing to save: yt-dlp knows no profile of it. It is shown, and cannot be chosen. */
export const isUnusable = (browser: Browser): boolean =>
  browser.spec === '' || browser.warning === 'noProfile';

/**
 * The key of the sentence under the browser's name, `null` for a browser that has nothing to say. An
 * entry that is unusable says why, whatever else its warning is. A `BrowserWarning` that is added to
 * Rust's and not handled here fails to compile: the function would lack a return for it.
 */
export function noteKeyOf(browser: Browser): string | null {
  if (isUnusable(browser)) return NO_PROFILE_NOTE;
  switch (browser.warning) {
    case null:
      return null;
    case 'chromiumCookies':
      return CHROMIUM_NOTE;
    case 'noProfile':
      return NO_PROFILE_NOTE;
  }
}

/** A browser that cannot be chosen sorts after the ones that can; one with a warning after those without. */
const rank = (browser: Browser): number => (isUnusable(browser) ? 2 : browser.warning === null ? 0 : 1);

/**
 * Rust's list in the order the lists show it: Firefox and its forks (no warning), the Chromium
 * browsers (with the warning), then the entries without a profile. Rust's order is kept within each.
 */
export function orderBrowsers(browsers: readonly Browser[]): Browser[] {
  // `sort` is stable.
  return [...browsers].sort((a, b) => rank(a) - rank(b));
}
