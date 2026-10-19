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
 * - "Settings" is on every row. It opens the plugin's settings (`PluginSettings`: a form from its
 *   schema, or its keys and values) under the row, in the flow of the page, and closes them again;
 *   it is `aria-expanded` like the errors badge. Opened with the keyboard, the focus goes to the
 *   panel (Tab then reaches its fields; without that, "Uninstall" would be in the way). Esc closes
 *   the panel and the focus goes back to "Settings".
 * - The arrow keys of the row's own controls (the switch, the errors badge, "Settings",
 *   "Uninstall") move between the rows (to the next row's switch; they wrap). The log, the open
 *   question and the settings panel have the arrows for themselves: the log scrolls (`PluginLog`),
 *   the question's two buttons trade the focus, the settings' fields are theirs. Esc closes an open
 *   confirmation, log or settings panel (one that the Esc came from, else the confirmation first),
 *   unless a field in them used it already (a list that closes, typing that is dropped). All of them
 *   say so with `preventDefault`, so that mpv does not get the key (a seek, leaving the fullscreen).
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../input/forward';
import type { PluginInfo } from '../ipc/types';
import fields from '../settings/fields/Fields.module.css';
import Icon, { CHEVRON_DOWN } from '../shell/Icon';
import { localized } from './localized';
import PluginLog from './PluginLog';
import PluginSettings from './PluginSettings';
import styles from './PluginsPage.module.css';
import { problemText, type PluginProblem } from './problem';

/** The log, the open question and the settings: what in a row has keys of its own. */
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
  const settingsId = `${ids}-settings`;
  const [logOpen, setLogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const uninstallButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const logToggle = useRef<HTMLButtonElement>(null);
  const settingsToggle = useRef<HTMLButtonElement>(null);
  const settingsPanel = useRef<HTMLDivElement>(null);
  /** "Settings" was pressed with the keyboard: the focus goes into the panel once it is there. */
  const settingsByKeyboard = useRef(false);
  const idle = !busy && !locked;

  const reportsErrors = plugin.errors > 0;
  const showLog = logOpen && reportsErrors;

  // The question is asked: the focus goes to the answer that changes nothing.
  useEffect(() => {
    if (confirming) cancelButton.current?.focus();
  }, [confirming]);

  // The settings were opened with the keyboard: the focus goes into them.
  useEffect(() => {
    if (!settingsOpen || !settingsByKeyboard.current) return;
    settingsByKeyboard.current = false;
    settingsPanel.current?.focus();
  }, [settingsOpen]);

  const notes: string[] = [];
  if (plugin.summary !== null) notes.push(localized(plugin.summary, i18n.language));
  if (plugin.copyOf !== null) notes.push(t('plugins.row.copyOf', { essential: plugin.copyOf }));
  if (plugin.incompatible) notes.push(t('plugins.row.incompatibleText'));
  if (plugin.duplicate) notes.push(t('plugins.row.duplicateText'));
  if (!plugin.enabled && plugin.running) notes.push(t('plugins.row.stopsOnApply'));

  // From the log, the question or the settings: those have the arrows for themselves.
  const fromExtra = (e: KeyboardEvent<HTMLLIElement>): boolean =>
    e.target instanceof Element && e.currentTarget.contains(e.target.closest(EXTRA));

  const onConfirmKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !ARROWS.has(e.key)) return;
    // Two buttons: any arrow goes to the other one. Handled here, so mpv does not seek.
    e.preventDefault();
    const other = document.activeElement === cancelButton.current ? confirmButton : cancelButton;
    other.current?.focus();
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    settingsToggle.current?.focus();
  };

  /** What the Esc closes: the settings if it came from them, else the question, the log, the settings. */
  const escapeTarget = (e: KeyboardEvent<HTMLLIElement>): 'confirm' | 'log' | 'settings' | null => {
    const inSettings = e.target instanceof Node && settingsPanel.current?.contains(e.target);
    if (settingsOpen && inSettings === true) return 'settings';
    if (confirming) return 'confirm';
    if (showLog) return 'log';
    return settingsOpen ? 'settings' : null;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (fromExtra(e)) return;
      // Handled here: mpv does not get the arrow too.
      e.preventDefault();
      onMove(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Escape' && !e.defaultPrevented) {
      // A field of the settings that used the Esc (an open list, typing to drop) has handled it.
      const target = escapeTarget(e);
      if (target === null) return;
      // Handled here: the key does not go on to mpv, where it would leave the fullscreen.
      e.preventDefault();
      if (target === 'confirm') {
        onCancelUninstall();
        uninstallButton.current?.focus();
      } else if (target === 'log') {
        setLogOpen(false);
        logToggle.current?.focus();
      } else {
        closeSettings();
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
          ref={settingsToggle}
          type="button"
          className={styles.quiet}
          aria-label={t('plugins.row.settingsLabel', { name: plugin.name })}
          aria-expanded={settingsOpen}
          aria-controls={settingsOpen ? settingsId : undefined}
          onClick={(e) => {
            // Enter or Space: no pointer behind the click.
            settingsByKeyboard.current = !settingsOpen && e.detail === 0;
            setSettingsOpen((open) => !open);
          }}
          {...blurAfterPointer}
        >
          {t('plugins.row.settings')}
        </button>
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

      {settingsOpen && (
        <PluginSettings ref={settingsPanel} id={settingsId} name={plugin.name} locked={locked} />
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
