/**
 * One plugin on My plugins (spec 7.3): its name, version and where it came from, what is worth
 * knowing about it, the switch, and "Uninstall".
 *
 * - The name is `PluginInfo.name`, shown as it is (a script the user added is its file name, `my.lua`).
 *   An essential also says what it does (`summary`, in the language of the UI).
 * - Badges: the source (Essentials, Added by hand, ...), "Incompatible" (it draws its own interface
 *   over the video, spec 6.5) and "Duplicate" (mpv knows another script that is on by the same
 *   name), each with its explanation in the row; and "Reports errors: N" (spec 10.4), which is a
 *   button: it opens the plugin's log under the row (`PluginLog`) and closes it again.
 * - A manual copy of an essential (`copyOf`) says so: Kaleido sets no options for it, so what it
 *   does depends on the user's own script and settings. A plugin that is off but still runs says
 *   that it runs until Apply.
 * - The switch is a `role="switch"` named by the plugin. "Uninstall" opens a confirmation in the
 *   row, not in a popover (Ruling R46): the files go to the Recycle Bin, and the settings stay. The
 *   focus goes to Cancel, the safe answer; Esc closes the confirmation and the focus goes back to
 *   "Uninstall". Only one row asks at a time (the page holds which).
 * - While an action on the row runs, or Apply does, the controls are `aria-disabled` and do
 *   nothing; they are not `disabled`, which would take the focus from the keyboard user who just
 *   pressed one. What Rust refused is said in the row, as an alert.
 * - The arrow keys of the row's own controls (the switch, the errors badge, "Uninstall") move
 *   between the rows (to the next row's switch; they wrap). The log and the open question have the
 *   arrows for themselves: the log scrolls (`PluginLog`), the question's two buttons trade the
 *   focus. Esc closes an open confirmation or log. All of them say so with `preventDefault`, so
 *   that mpv does not get the key (a seek, leaving the fullscreen).
 *
 * The "Settings" button is Task 14's: there is none until it exists.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../input/forward';
import type { PluginInfo } from '../ipc/types';
import fields from '../settings/fields/Fields.module.css';
import Icon, { CHEVRON_DOWN } from '../shell/Icon';
import { localized } from './localized';
import PluginLog from './PluginLog';
import styles from './PluginsPage.module.css';
import { problemText, type PluginProblem } from './problem';

/** The log and the open question: what in a row has keys of its own. */
const EXTRA = '[role="region"], [role="group"]';

/** The arrows that trade the focus between the question's two buttons. */
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export interface PluginRowProps {
  plugin: PluginInfo;
  /** An action on this plugin is on its way. */
  busy: boolean;
  /** Apply runs: nothing changes meanwhile. */
  locked: boolean;
  /** What Rust refused for this plugin last. */
  problem: PluginProblem | null;
  /** The confirmation of "Uninstall" is open. */
  confirming: boolean;
  onToggle: (on: boolean) => void;
  onAskUninstall: () => void;
  onCancelUninstall: () => void;
  onUninstall: () => void;
  /** The row's switch: where the arrow keys of the other rows go. */
  switchRef: Ref<HTMLButtonElement>;
  /** An arrow key: to the row before (-1) or after (1) this one. */
  onMove: (step: -1 | 1) => void;
}

export default function PluginRow({
  plugin,
  busy,
  locked,
  problem,
  confirming,
  onToggle,
  onAskUninstall,
  onCancelUninstall,
  onUninstall,
  switchRef,
  onMove,
}: PluginRowProps) {
  const { t, i18n } = useTranslation();
  const ids = useId();
  const nameId = `${ids}-name`;
  const notesId = `${ids}-notes`;
  const confirmId = `${ids}-confirm`;
  const questionId = `${ids}-question`;
  const logId = `${ids}-log`;
  const [logOpen, setLogOpen] = useState(false);
  const uninstallButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const logToggle = useRef<HTMLButtonElement>(null);
  const idle = !busy && !locked;

  const reportsErrors = plugin.errors > 0;
  const showLog = logOpen && reportsErrors;

  // The question is asked: the focus goes to the answer that changes nothing.
  useEffect(() => {
    if (confirming) cancelButton.current?.focus();
  }, [confirming]);

  const notes: string[] = [];
  if (plugin.summary !== null) notes.push(localized(plugin.summary, i18n.language));
  if (plugin.copyOf !== null) notes.push(t('plugins.row.copyOf', { essential: plugin.copyOf }));
  if (plugin.incompatible) notes.push(t('plugins.row.incompatibleText'));
  if (plugin.duplicate) notes.push(t('plugins.row.duplicateText'));
  if (!plugin.enabled && plugin.running) notes.push(t('plugins.row.stopsOnApply'));

  // From the log or the question: those have the arrows for themselves.
  const fromExtra = (e: KeyboardEvent<HTMLLIElement>): boolean =>
    e.target instanceof Element && e.currentTarget.contains(e.target.closest(EXTRA));

  const onConfirmKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !ARROWS.has(e.key)) return;
    // Two buttons: any arrow goes to the other one. Handled here, so mpv does not seek.
    e.preventDefault();
    const other = document.activeElement === cancelButton.current ? confirmButton : cancelButton;
    other.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (fromExtra(e)) return;
      // Handled here: mpv does not get the arrow too.
      e.preventDefault();
      onMove(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Escape' && (confirming || showLog)) {
      // Handled here: the key does not go on to mpv, where it would leave the fullscreen.
      e.preventDefault();
      if (confirming) {
        onCancelUninstall();
        uninstallButton.current?.focus();
      } else {
        setLogOpen(false);
        logToggle.current?.focus();
      }
    }
  };

  return (
    <li className={styles.row} data-plugin={plugin.name} aria-busy={busy} onKeyDown={onKeyDown}>
      <div className={styles.main}>
        <div className={styles.titleLine}>
          <span id={nameId} className={styles.name}>
            {plugin.name}
          </span>
          {plugin.version !== null && (
            <span className={styles.version}>
              {t('plugins.row.version', { version: plugin.version })}
            </span>
          )}
        </div>
        <div className={styles.badges}>
          <span className={styles.badge} data-kind="source">
            {t(`plugins.source.${plugin.source}`)}
          </span>
          {plugin.incompatible && (
            <span className={styles.badge} data-kind="warning">
              {t('plugins.row.incompatible')}
            </span>
          )}
          {plugin.duplicate && (
            <span className={styles.badge} data-kind="warning">
              {t('plugins.row.duplicate')}
            </span>
          )}
          {reportsErrors && (
            <button
              ref={logToggle}
              type="button"
              className={`${styles.badge} ${styles.badgeButton}`}
              data-kind="error"
              aria-expanded={showLog}
              aria-controls={showLog ? logId : undefined}
              onClick={() => {
                setLogOpen((open) => !open);
              }}
              {...blurAfterPointer}
            >
              {t('plugins.row.errors', { errors: plugin.errors })}
              <span className={styles.chevron} data-open={showLog}>
                <Icon path={CHEVRON_DOWN} />
              </span>
            </button>
          )}
        </div>
        {notes.length > 0 && (
          <div id={notesId} className={styles.notes}>
            {notes.map((note) => (
              <p key={note} className={styles.note}>
                {note}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className={styles.controls}>
        <button
          ref={switchRef}
          type="button"
          role="switch"
          className={`${fields.switch} ${styles.switch}`}
          aria-checked={plugin.enabled}
          aria-labelledby={nameId}
          aria-describedby={notes.length > 0 ? notesId : undefined}
          aria-disabled={!idle}
          onClick={() => {
            if (idle) onToggle(!plugin.enabled);
          }}
          {...blurAfterPointer}
        />
        <span className={styles.switchText} aria-hidden>
          {plugin.enabled ? t('plugins.row.on') : t('plugins.row.off')}
        </span>
        <button
          ref={uninstallButton}
          type="button"
          className={styles.quiet}
          aria-label={t('plugins.row.uninstallLabel', { name: plugin.name })}
          aria-expanded={confirming}
          aria-controls={confirming ? confirmId : undefined}
          aria-disabled={!idle}
          onClick={() => {
            if (!idle) return;
            if (confirming) onCancelUninstall();
            else onAskUninstall();
          }}
          {...blurAfterPointer}
        >
          {t('plugins.row.uninstall')}
        </button>
      </div>

      {confirming && (
        <div
          id={confirmId}
          role="group"
          aria-labelledby={questionId}
          className={styles.confirm}
          onKeyDown={onConfirmKeyDown}
        >
          <p id={questionId} className={styles.confirmText}>
            {t('plugins.confirm.question', { name: plugin.name })}
          </p>
          {plugin.source === 'bundled' && (
            <p className={styles.confirmText}>{t('plugins.confirm.essential')}</p>
          )}
          <div className={styles.confirmActions}>
            <button
              ref={confirmButton}
              type="button"
              className={styles.danger}
              aria-disabled={!idle}
              onClick={() => {
                if (idle) onUninstall();
              }}
              {...blurAfterPointer}
            >
              {t('plugins.confirm.yes')}
            </button>
            <button
              ref={cancelButton}
              type="button"
              className={styles.secondary}
              onClick={(e) => {
                onCancelUninstall();
                // After the keyboard the focus goes back; after the pointer it is let go of.
                if (e.detail === 0) uninstallButton.current?.focus();
              }}
              {...blurAfterPointer}
            >
              {t('plugins.confirm.no')}
            </button>
          </div>
        </div>
      )}

      {showLog && <PluginLog id={logId} name={plugin.name} errors={plugin.errors} />}

      {problem !== null && (
        <p role="alert" className={styles.problem}>
          {problemText(problem, t)}
        </p>
      )}
    </li>
  );
}
