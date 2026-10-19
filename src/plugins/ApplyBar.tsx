/**
 * The apply bar of My plugins (spec 7.3, 6.3): at the top of the page, and it stays there as the
 * list scrolls (`position: sticky`, in the flow of the page and not a layer of its own, Ruling
 * R46). It shows while a change waits for "Apply" (`restartNeeded`) or Apply runs: a plugin turned
 * off or uninstalled keeps running until the player's core restarts, and the restart plays on at
 * the same place. While Apply runs the button is off and the bar shows that something is going on;
 * when it is done the bar goes.
 *
 * - It is a `role="status"` region that is in the page all the time and only gets its content: a
 *   region that arrives together with its text is announced unreliably (see `ErrorCards.tsx`).
 * - The button is not `disabled` while Apply runs but `aria-disabled`: a disabled button that has
 *   the focus loses it, and the keyboard user would find themselves at the top of the page.
 * - When Apply is done and the bar goes with the focus in it (or the focus lost with it), the
 *   focus goes to the page's heading, so that the keyboard starts again from the top.
 * - A refused Apply (the player could not be restarted) is said under the bar as an alert; the
 *   changes still wait, and the bar stays.
 * - The bar covers the top of the scrolled list, so it tells the page how tall it is (`onHeight`,
 *   0 while it shows nothing): the card scrolls a focused row clear of it (`scroll-padding-top`,
 *   WCAG 2.4.11).
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../input/forward';
import styles from './PluginsPage.module.css';
import type { PluginProblem } from './problem';
import ProblemText from './ProblemText';

export interface ApplyBarProps {
  /** A change waits for Apply. */
  waiting: boolean;
  /** Apply runs. */
  applying: boolean;
  /** Why the last Apply did not happen. */
  problem: PluginProblem | null;
  onApply: () => void;
  /** Apply is done and the bar is gone: where the focus was in it, it is lost. */
  onDone: () => void;
  /** How tall the bar is now (CSS px), with what it says under it; 0 while there is nothing. */
  onHeight: (height: number) => void;
}

export default function ApplyBar({
  waiting,
  applying,
  problem,
  onApply,
  onDone,
  onHeight,
}: ApplyBarProps) {
  const { t } = useTranslation();
  const area = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const ran = useRef(false);

  // Measured before the paint, and again whenever it changes size (a narrow window wraps it).
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return undefined;
    const report = () => {
      onHeight(element.offsetHeight);
    };
    report();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [onHeight]);

  useEffect(() => {
    if (applying) {
      ran.current = true;
      return;
    }
    if (!ran.current) return;
    ran.current = false;
    if (waiting) return;
    // The focus is lost (on the page, or on the button that went), or still in the bar.
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      !active.isConnected ||
      slot.current?.contains(active)
    ) {
      onDone();
    }
  }, [applying, waiting, onDone]);

  return (
    <div ref={area} className={styles.applyArea}>
      <div ref={slot} role="status" aria-label={t('plugins.apply.label')} className={styles.applySlot}>
        {(waiting || applying) && (
          <div className={styles.apply} data-applying={applying}>
            {applying && <span className={styles.spinner} aria-hidden />}
            <p className={styles.applyText}>
              {applying ? t('plugins.apply.progress') : t('plugins.apply.text')}
            </p>
            <button
              type="button"
              className={styles.primary}
              aria-disabled={applying}
              onClick={() => {
                if (!applying) onApply();
              }}
              {...blurAfterPointer}
            >
              {applying ? t('plugins.apply.applying') : t('plugins.apply.button')}
            </button>
          </div>
        )}
      </div>
      {problem !== null && (
        <p role="alert" className={styles.problem}>
          <ProblemText problem={problem} />
        </p>
      )}
    </div>
  );
}
