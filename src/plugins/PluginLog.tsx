/**
 * The errors a plugin logged in this run (spec 10.4), under its row: mpv's log lines, oldest first,
 * the way the "Details" of an error card show them (`[prefix] text`). Rust keeps the last few
 * (`plugins_log`); the lines are read when the log opens, and again whenever the plugin's count of
 * errors grows while it is open (`plugins:changed` carries the count). It is part of the page, in
 * the row (Ruling R46: no popover on a page), and a scrollable region that can take the focus, so
 * that a keyboard user can scroll it: the arrows, Page Up and Page Down, Home and End scroll it
 * (and say so with `preventDefault`, so that mpv does not seek with them), where the arrows of the
 * row's other controls move between the rows (`PluginRow`). Esc is the row's: it closes the log.
 */

import { useEffect, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { pluginsLog } from '../ipc/commands';
import type { LogLine } from '../ipc/types';
import styles from './PluginsPage.module.css';

type Lines =
  | { status: 'loading' }
  | { status: 'ready'; lines: readonly LogLine[] }
  | { status: 'failed' };

/** A line of the log as the details of an error card show it. */
export const logLine = (line: LogLine): string => `[${line.prefix}] ${line.text.trim()}`;

/** What an arrow key scrolls the log by, CSS px. */
export const LOG_LINE_PX = 32;

/** Where a key scrolls the log to, from where it is; `null` for a key that scrolls nothing. */
function scrolledTo(key: string, element: HTMLElement): number | null {
  switch (key) {
    case 'ArrowDown':
      return element.scrollTop + LOG_LINE_PX;
    case 'ArrowUp':
      return element.scrollTop - LOG_LINE_PX;
    case 'PageDown':
      return element.scrollTop + element.clientHeight;
    case 'PageUp':
      return element.scrollTop - element.clientHeight;
    case 'Home':
      return 0;
    case 'End':
      return element.scrollHeight;
    default:
      return null;
  }
}

export interface PluginLogProps {
  /** The id the row's badge points at with `aria-controls`. */
  id: string;
  /** `PluginInfo.name`. */
  name: string;
  /** The plugin's count of errors: the log is read again when it changes. */
  errors: number;
}

export default function PluginLog({ id, name, errors }: PluginLogProps) {
  const { t } = useTranslation();
  const [log, setLog] = useState<Lines>({ status: 'loading' });

  // The lines that are shown stay until the new ones are here.
  useEffect(() => {
    let current = true;
    pluginsLog(name).then(
      (lines) => {
        if (current) setLog({ status: 'ready', lines });
      },
      (error: unknown) => {
        console.warn('plugins_log', error);
        if (current) setLog({ status: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [name, errors]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const to = scrolledTo(e.key, e.currentTarget);
    if (to === null) return;
    // Handled here: mpv does not get the key, and the row does not take it for a move.
    e.preventDefault();
    e.currentTarget.scrollTop = Math.max(0, to);
  };

  return (
    <div
      id={id}
      role="region"
      aria-label={t('plugins.log.label', { name })}
      // Scrollable: the keyboard has to reach it.
      tabIndex={0}
      className={styles.log}
      onKeyDown={onKeyDown}
    >
      {log.status === 'loading' && <p className={styles.line}>{t('plugins.log.loading')}</p>}
      {log.status === 'failed' && <p className={styles.line}>{t('plugins.log.failed')}</p>}
      {log.status === 'ready' &&
        (log.lines.length > 0 ? (
          log.lines.map((line, index) => (
            <p key={index} className={styles.line}>
              {logLine(line)}
            </p>
          ))
        ) : (
          <p className={styles.line}>{t('plugins.log.empty')}</p>
        ))}
    </div>
  );
}
