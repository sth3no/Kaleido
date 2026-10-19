/**
 * My plugins (spec 7.3), a page beside the docked sidebar: the title, the apply bar, the list of
 * plugins (`PluginRow`) and, when there is something to bring back, "Restore essentials". A plugin
 * is an ordinary mpv script; the list is whatever is in the config folder, essentials and the
 * scripts the user put there alike.
 *
 * - The plugins come from Rust when the page opens (`pluginsStore`), and follow `plugins:changed`
 *   (a change, Apply starting and ending, a plugin's count of errors). The page reads nothing from
 *   the player: during Apply the player's state is briefly idle and empty (the restart), and none of
 *   it is the page's business.
 * - The apply bar (`ApplyBar`) shows while a change waits for Apply. While Apply runs (`applying`
 *   stays true until the new core plays on) the switches, "Uninstall" and Apply are off.
 * - The confirmation of "Uninstall" and the plugin's log open in the row, in the flow of the page,
 *   never in a popover or any layer of their own: the page layer is clipped around the mini player
 *   (Ruling R46). Only one row asks at a time; the page holds which.
 * - Uninstall takes a row away, and the focus with it; it goes to the row next to it, or to the
 *   heading when there is none.
 * - "Restore essentials" brings back the essentials the user removed. When a script of the user's
 *   own of the same name is in the way, Rust drops the stale record and installs nothing: that
 *   essential is then neither listed nor offered, so the page says so after the action instead of
 *   saying nothing (`restoreReport`).
 * - The top of a docked page is the window's title bar (a drag strip over it), so nothing of the
 *   page is there. While a video plays, the mini player is in the corner and the shell clips the
 *   page around it: the card keeps room at its end (`--plugins-mini-reserve`) so that the last rows
 *   can be scrolled clear of the video.
 *
 * The page does not leave anything behind: what it said about its last actions goes when it is left.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../input/forward';
import { MINI } from '../surface/mini';
import glass from '../theme/glass.module.css';
import ApplyBar from './ApplyBar';
import { listOf } from './localized';
import PluginRow from './PluginRow';
import styles from './PluginsPage.module.css';
import { listenToPlugins, usePluginsStore } from './pluginsStore';
import { problemText } from './problem';

export default function PluginsPage() {
  const { t, i18n } = useTranslation();
  const state = usePluginsStore((data) => data.state);
  const loadFailed = usePluginsStore((data) => data.loadFailed);
  const busy = usePluginsStore((data) => data.busy);
  const error = usePluginsStore((data) => data.error);
  const applyPending = usePluginsStore((data) => data.applyPending);
  const applyProblem = usePluginsStore((data) => data.applyProblem);
  const restoring = usePluginsStore((data) => data.restoring);
  const restoreProblem = usePluginsStore((data) => data.restoreProblem);
  const restored = usePluginsStore((data) => data.restored);

  /** The row that asks whether to uninstall. */
  const [asking, setAsking] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const switches = useRef(new Map<string, HTMLButtonElement>());
  /** An uninstall is on its way: the plugin, and the row the focus goes to once it is gone. */
  const removal = useRef<{ name: string; next: string | null } | null>(null);
  const restoreButton = useRef<HTMLButtonElement>(null);
  const report = useRef<HTMLDivElement>(null);
  /** "Restore essentials" was pressed with the keyboard: the focus goes to the report if the button goes. */
  const reportFocus = useRef(false);
  const hintId = useId();

  // Subscribed before the plugins are read: a change in between is not lost.
  useEffect(() => listenToPlugins(), []);
  useEffect(() => {
    void usePluginsStore.getState().load();
    return () => {
      usePluginsStore.getState().leave();
    };
  }, []);

  const listed = state?.plugins;
  const plugins = useMemo(() => listed ?? [], [listed]);
  const removed = state?.removedEssentials ?? [];
  const applying = (state?.applying ?? false) || applyPending;
  // A row that is gone cannot be asking.
  const askingName = plugins.some((plugin) => plugin.name === asking) ? asking : null;

  // The plugin that was uninstalled is gone: the focus it had goes on to the next row.
  useEffect(() => {
    const pending = removal.current;
    if (pending === null || plugins.some((plugin) => plugin.name === pending.name)) return;
    removal.current = null;
    const next = pending.next === null ? undefined : switches.current.get(pending.next);
    (next ?? heading.current)?.focus();
  }, [plugins]);

  // "Restore essentials" was pressed and has gone with the last essential: the report is where to go on.
  useEffect(() => {
    if (!reportFocus.current || restoring) return;
    reportFocus.current = false;
    if (!restoreButton.current?.isConnected) report.current?.focus();
  }, [restoring, removed.length, restored]);

  const focusHeading = useCallback(() => {
    heading.current?.focus();
  }, []);

  const move = (from: string, step: -1 | 1) => {
    const index = plugins.findIndex((plugin) => plugin.name === from);
    const target = plugins[(index + step + plugins.length) % plugins.length];
    if (index >= 0 && target) switches.current.get(target.name)?.focus();
  };

  const uninstall = async (name: string) => {
    const index = plugins.findIndex((plugin) => plugin.name === name);
    const next = plugins[index + 1] ?? plugins[index - 1];
    removal.current = { name, next: next?.name ?? null };
    const done = await usePluginsStore.getState().uninstall(name);
    if (done) setAsking(null);
    else removal.current = null;
  };

  const restore = () => {
    reportFocus.current = document.activeElement === restoreButton.current;
    void usePluginsStore.getState().restoreEssentials();
  };

  // The plugin whose action was refused is gone from the list: nothing to say it at.
  const orphan =
    state !== null && error !== null && !plugins.some((plugin) => plugin.name === error.name)
      ? error
      : null;

  return (
    <div
      className={styles.page}
      style={{ '--plugins-mini-reserve': `${MINI.w}px` } as CSSProperties}
    >
      <header className={styles.header}>
        <h1 ref={heading} tabIndex={-1} className={styles.title}>
          {t('plugins.title')}
        </h1>
        <p className={styles.intro}>{t('plugins.intro')}</p>
      </header>
      <div
        className={`${glass.glass} ${styles.content}`}
        aria-busy={state === null && !loadFailed}
      >
        <ApplyBar
          waiting={state?.restartNeeded ?? false}
          applying={applying}
          problem={applyProblem}
          onApply={() => {
            void usePluginsStore.getState().apply();
          }}
          onDone={focusHeading}
        />

        {state === null &&
          (loadFailed ? (
            <div role="alert" className={styles.failure}>
              <p className={styles.failureText}>{t('plugins.loadFailed')}</p>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => {
                  void usePluginsStore.getState().load();
                }}
                {...blurAfterPointer}
              >
                {t('plugins.retry')}
              </button>
            </div>
          ) : (
            <p className={styles.empty}>{t('plugins.loading')}</p>
          ))}

        {state !== null &&
          (plugins.length === 0 ? (
            <p className={styles.empty}>{t('plugins.empty')}</p>
          ) : (
            <ul className={styles.list} aria-label={t('plugins.list')}>
              {plugins.map((plugin) => (
                <PluginRow
                  key={plugin.name}
                  plugin={plugin}
                  busy={busy.has(plugin.name)}
                  locked={applying}
                  problem={error?.name === plugin.name ? error : null}
                  confirming={askingName === plugin.name}
                  onToggle={(on) => {
                    void usePluginsStore.getState().setEnabled(plugin.name, on);
                  }}
                  onAskUninstall={() => {
                    setAsking(plugin.name);
                  }}
                  onCancelUninstall={() => {
                    setAsking(null);
                  }}
                  onUninstall={() => {
                    void uninstall(plugin.name);
                  }}
                  switchRef={(element) => {
                    if (element) switches.current.set(plugin.name, element);
                    else switches.current.delete(plugin.name);
                  }}
                  onMove={(step) => {
                    move(plugin.name, step);
                  }}
                />
              ))}
            </ul>
          ))}

        {orphan !== null && (
          <p role="alert" className={styles.problem}>
            {orphan.code === 'notFound'
              ? t('plugins.errors.gone', { name: orphan.name })
              : problemText(orphan, t)}
          </p>
        )}

        <div className={styles.restore}>
          {removed.length > 0 && (
            <>
              <button
                ref={restoreButton}
                type="button"
                className={styles.secondary}
                aria-disabled={applying || restoring}
                aria-describedby={hintId}
                onClick={() => {
                  if (!applying && !restoring) restore();
                }}
                {...blurAfterPointer}
              >
                {t('plugins.restore.button')}
              </button>
              <p id={hintId} className={styles.hint}>
                {t('plugins.restore.hint', { names: listOf(removed, i18n.language) })}
              </p>
            </>
          )}
          {/* Always in the page, so that what it comes to say is announced. */}
          <div
            ref={report}
            role="status"
            aria-label={t('plugins.restore.label')}
            tabIndex={-1}
            className={styles.report}
          >
            {restored !== null && restored.back.length > 0 && (
              <p className={styles.reportLine}>
                {t('plugins.restore.back', { names: listOf(restored.back, i18n.language) })}
              </p>
            )}
            {restored !== null && restored.blocked.length > 0 && (
              <p className={styles.reportLine}>
                {t('plugins.restore.blocked', { names: listOf(restored.blocked, i18n.language) })}
              </p>
            )}
          </div>
          {restoreProblem !== null && (
            <p role="alert" className={styles.problem}>
              {problemText(restoreProblem, t)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
