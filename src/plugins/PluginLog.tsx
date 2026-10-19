/**
 * The errors a plugin logged in this run (spec 10.4), under its row: mpv's log lines, oldest first,
 * the way the "Details" of an error card show them (`[prefix] text`). Rust keeps the last few
 * (`plugins_log`); the lines are read when the log opens, and again whenever the plugin's count of
 * errors grows while it is open (`plugins:changed` carries the count). It is part of the page, in
 * the row (Ruling R46: no popover on a page), and a scrollable region that can take the focus, so
 * that a keyboard user can scroll it.
 */

import { useEffect, useState } from 'react';
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

  return (
    <div
      id={id}
      role="region"
      aria-label={t('plugins.log.label', { name })}
      // Scrollable: the keyboard has to reach it.
      tabIndex={0}
      className={styles.log}
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
