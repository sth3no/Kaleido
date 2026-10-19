/**
 * The browser to take cookies from, on the card of a link that wants them (spec 10.3, decision 19):
 * a list of the browsers Rust found on this PC (`system_browsers`) in the card itself, not in a
 * popover, so that it is part of the card and goes with it (a layer of its own would sit outside the
 * glass, Ruling R46). The choice is saved as `playback.cookiesFromBrowser` and the link is tried
 * again by whoever owns the card (`onUse`, `streamNotice.ts`).
 *
 * - The browsers whose cookies yt-dlp can read come first (Firefox and its forks), then the Chromium
 *   ones, each with the warning Rust gives it (on Windows yt-dlp mostly cannot read their cookies, and
 *   the link then fails as a whole), then the ones without a profile, which are shown with their
 *   sentence and cannot be chosen: an entry with an empty `spec` is never saved. The order within
 *   those groups is Rust's.
 * - With `offerNone` the list ends with "Do not use cookies" (`null`), the way out of a choice yt-dlp
 *   cannot read (the class `cookies`).
 * - No browser found, or a list that could not be read: a sentence and a link to Settings → Playback,
 *   where the same choice is made by hand (`onOpenSettings`: the card closes and the page opens, so
 *   the card does not stay over it). "Do not use cookies" is still offered where it applies.
 * - A radio group: the arrows, Home and End move the focus and say so with `preventDefault` (mpv does
 *   not also get them); Enter and Space choose, as a click does. Nothing is chosen at first, and "Use
 *   and try again" waits for a choice. Where the focus goes when the list is there is the caller's
 *   word (`focusOnReady`: the chooser was opened with the keyboard). Esc is the card's: it closes the
 *   chooser before it closes itself (`ErrorCard.tsx`).
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../../input/forward';
import { systemBrowsers } from '../../ipc/commands';
import type { Browser } from '../../ipc/types';
import panel from '../../panels/Panel.module.css';
import Icon, { CHECK } from '../Icon';
import styles from './BrowserChooser.module.css';
import card from './ErrorCards.module.css';

/** An entry with nothing to save: yt-dlp knows no profile of it. */
const isUnusable = (browser: Browser): boolean =>
  browser.spec === '' || browser.warning === 'noProfile';

/** A browser that cannot be chosen sorts after the ones that can; one with a warning after those without. */
const rank = (browser: Browser): number => (isUnusable(browser) ? 2 : browser.warning === null ? 0 : 1);

/**
 * Rust's list in the order the chooser shows it: Firefox and its forks (no warning), the Chromium
 * browsers (with the warning), then the entries without a profile. Rust's order is kept within each.
 */
export function orderBrowsers(browsers: readonly Browser[]): Browser[] {
  // `sort` is stable.
  return [...browsers].sort((a, b) => rank(a) - rank(b));
}

/** What a row of the list stands for. */
interface Choice {
  key: string;
  label: string;
  /** What `playback.cookiesFromBrowser` takes; `null` for "Do not use cookies". */
  spec: string | null;
  /** The key of the sentence under the label. */
  note: string | null;
  /** Shown, but not to be chosen. */
  unusable: boolean;
}

const NONE_KEY = 'none';

function choiceOf(browser: Browser): Choice {
  const unusable = isUnusable(browser);
  return {
    key: `browser:${browser.id}`,
    label: browser.label,
    spec: browser.spec,
    note: unusable
      ? 'errors.browser.noProfile'
      : browser.warning === 'chromiumCookies'
        ? 'errors.browser.chromiumCookies'
        : null,
    unusable,
  };
}

type Listing =
  | { status: 'loading' }
  | { status: 'ready'; browsers: Browser[] }
  | { status: 'failed' };

export interface BrowserChooserProps {
  /** Offer "Do not use cookies": the cookies of the browser chosen before cannot be read. */
  offerNone: boolean;
  /** Saving and trying again runs: the list stands still and "Use and try again" does nothing. */
  busy: boolean;
  /** The chooser was opened with the keyboard: the focus goes to the list once it is there. */
  focusOnReady: boolean;
  /** "Use and try again" with the choice: a `Browser.spec`, `null` for no cookies. */
  onUse: (spec: string | null) => void;
  /** The link to Settings → Playback: the owner of the chooser closes the card and opens the page. */
  onOpenSettings: () => void;
}

export default function BrowserChooser({
  offerNone,
  busy,
  focusOnReady,
  onUse,
  onOpenSettings,
}: BrowserChooserProps) {
  const { t } = useTranslation();
  const labelId = useId();
  const rowId = useId();
  const [listing, setListing] = useState<Listing>({ status: 'loading' });
  /** The key of the choice; `null` until the user has chosen. */
  const [chosen, setChosen] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    let current = true;
    systemBrowsers().then(
      (browsers) => {
        if (current) setListing({ status: 'ready', browsers: Array.isArray(browsers) ? browsers : [] });
      },
      (error: unknown) => {
        console.warn('system_browsers', error);
        if (current) setListing({ status: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const found = listing.status === 'ready' ? listing.browsers.length : 0;
  const choices = useMemo<Choice[]>(() => {
    if (listing.status === 'loading') return [];
    const list = listing.status === 'ready' ? orderBrowsers(listing.browsers).map(choiceOf) : [];
    if (offerNone) {
      list.push({ key: NONE_KEY, label: t('errors.browser.none'), spec: null, note: null, unusable: false });
    }
    return list;
  }, [listing, offerNone, t]);

  // Browsers that can be chosen; without one the way on is Settings, whether or not "no cookies" is offered.
  const usable = choices.filter((choice) => choice.key !== NONE_KEY && !choice.unusable).length;
  const picked = choices.find((choice) => choice.key === chosen);
  // What Tab reaches: the choice, else the first one that can be chosen.
  const entry = Math.max(
    0,
    choices.findIndex((choice) => (picked ? choice === picked : !choice.unusable)),
  );

  // The focus goes in once the list is there: to the choice Tab reaches, else to the link.
  const settled = listing.status !== 'loading';
  useEffect(() => {
    if (!focusOnReady || !settled) return;
    root.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }, [focusOnReady, settled]);

  const choose = (choice: Choice) => {
    if (busy || choice.unusable) return;
    setChosen(choice.key);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const index = radios.current.findIndex((radio) => radio !== null && radio === document.activeElement);
    if (index < 0) return;
    const last = choices.length - 1;
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = Math.min(index + 1, last);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = Math.max(index - 1, 0);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next < 0) return;
    // Handled here: mpv does not get the arrow too.
    e.preventDefault();
    radios.current[next]?.focus();
  };

  return (
    <div ref={root} className={styles.chooser}>
      <p id={labelId} className={styles.label}>
        {t('errors.browser.label')}
      </p>
      {listing.status === 'loading' && (
        <p role="status" className={styles.message}>
          {t('errors.browser.loading')}
        </p>
      )}
      {listing.status === 'failed' && (
        <p role="alert" className={styles.message}>
          {t('errors.browser.failed')}
        </p>
      )}
      {listing.status === 'ready' && found === 0 && (
        <p className={styles.message}>{t('errors.browser.empty')}</p>
      )}
      {choices.length > 0 && (
        <div
          role="radiogroup"
          aria-labelledby={labelId}
          className={panel.options}
          onKeyDown={onKeyDown}
        >
          {choices.map((choice, index) => {
            const checked = choice.key === chosen;
            const labelOf = `${rowId}-label-${index}`;
            const noteOf = `${rowId}-note-${index}`;
            return (
              <button
                key={choice.key}
                ref={(element) => {
                  radios.current[index] = element;
                }}
                type="button"
                role="radio"
                className={choice.unusable ? `${panel.option} ${styles.unusable}` : panel.option}
                aria-checked={checked}
                // Focusable, so that the sentence that says why it cannot be chosen can be reached.
                aria-disabled={choice.unusable || undefined}
                aria-labelledby={labelOf}
                aria-describedby={choice.note === null ? undefined : noteOf}
                tabIndex={index === entry ? 0 : -1}
                data-autofocus={index === entry ? '' : undefined}
                onClick={() => {
                  choose(choice);
                }}
                {...blurAfterPointer}
              >
                <span className={panel.text}>
                  <span id={labelOf} className={panel.name}>
                    {choice.label}
                  </span>
                  {choice.note !== null && (
                    <span id={noteOf} className={styles.note}>
                      {t(choice.note)}
                    </span>
                  )}
                </span>
                {checked && <Icon path={CHECK} />}
              </button>
            );
          })}
        </div>
      )}
      {settled && (
        <div className={styles.footer}>
          {choices.length > 0 && (
            // Not `disabled`: the button keeps the focus while the choice is saved.
            <button
              type="button"
              className={card.action}
              aria-disabled={picked === undefined || busy}
              onClick={() => {
                if (picked !== undefined && !busy) onUse(picked.spec);
              }}
              {...blurAfterPointer}
            >
              {t('errors.browser.use')}
            </button>
          )}
          {usable === 0 && (
            <button
              type="button"
              className={card.action}
              data-autofocus={choices.length === 0 ? '' : undefined}
              onClick={onOpenSettings}
              {...blurAfterPointer}
            >
              {t('errors.browser.openSettings')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
