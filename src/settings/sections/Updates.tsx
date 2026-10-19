/**
 * Updates (spec 8.10, 6.6, plan decision 14): the tools Kaleido downloads and keeps up to date itself.
 *
 * - A row for yt-dlp and one for Deno, each with the version that is installed (or "Not installed"),
 *   when the release was last checked (told by `Intl`, relative to now: "3 hours ago"), what the tool is
 *   doing (downloading, checking, up to date, or that the last check failed, with Rust's reason under
 *   it) and "Check now". The state is read when the section opens and follows `tools:status`, so a check
 *   that runs in the background shows here. "Check now" is busy until Rust has answered, and keeps the
 *   focus meanwhile (`aria-disabled`, not `disabled`).
 * - Between them the channel of yt-dlp (`updates.ytdlpChannel`, Stable or Nightly), an ordinary
 *   setting row: nightly gets yt-dlp's fixes for websites sooner. Changing it makes Rust check at once,
 *   which the yt-dlp row shows. Deno has only its stable releases, so it has no channel.
 * - The version of libmpv, read the way About reads it. libmpv is not updated here: it comes with Kaleido.
 *
 * The app's own channel comes with the updater (M4); nothing stands in its place. The search finds this
 * section by the channel row, whose keywords name the tools, and shows all of it.
 */

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatRelativeTime } from '../../i18n/format';
import { blurAfterPointer } from '../../input/forward';
import { toolsCheck } from '../../ipc/commands';
import type { ToolId, ToolState, ToolStatus } from '../../ipc/types';
import { readVersions } from '../about';
import type { SectionId } from '../descriptors';
import { isToolStatus, useToolStatuses } from '../tools';
import SettingsList, { type SectionProps } from './SettingsList';
import styles from './Updates.module.css';

const SECTION: SectionId = 'updates';
/** The tools, in the order the section lists them: yt-dlp, its channel, Deno. */
const YT_DLP: ToolId = 'ytDlp';
const DENO: ToolId = 'deno';

interface ToolRowProps {
  tool: ToolId;
  /** `undefined` while it is not read. */
  status: ToolStatus | undefined;
  /** The read of the states failed. */
  unreadable: boolean;
  /** The state a check this row asked for ended in. */
  onStatus: (status: ToolStatus) => void;
  onRetry: () => void;
}

function ToolRow({ tool, status, unreadable, onStatus, onRetry }: ToolRowProps) {
  const { t } = useTranslation();
  const ids = useId();
  const nameId = `${ids}-name`;
  /** A check this row asked for is out. */
  const [pending, setPending] = useState(false);
  /** The last press could not even start the check. */
  const [refused, setRefused] = useState(false);

  const running = status?.state === 'checking' || status?.state === 'downloading';
  const busy = pending || running;
  // The press is the state at once, before the first event of the check has come.
  const state: ToolState | null =
    status === undefined ? null : pending && !running ? 'checking' : status.state;

  const check = () => {
    if (busy || status === undefined) return;
    setPending(true);
    setRefused(false);
    toolsCheck(tool).then(
      (answer) => {
        if (isToolStatus(answer)) onStatus(answer);
        setPending(false);
      },
      (reason: unknown) => {
        console.warn(`cannot check ${tool}`, reason);
        setRefused(true);
        setPending(false);
      },
    );
  };

  const checked = status?.checkedAt ? formatRelativeTime(status.checkedAt) : '';

  return (
    <div className={styles.row} role="group" aria-labelledby={nameId} data-tool={tool}>
      <div className={styles.text}>
        <span id={nameId} className={styles.name}>
          {t(`settings.updates.tools.${tool}`)}
        </span>
        <span className={styles.hint}>{t(`settings.updates.purpose.${tool}`)}</span>
        {status === undefined ? (
          unreadable ? (
            <span role="alert" className={styles.line}>
              {t('settings.updates.unreadable')}
            </span>
          ) : (
            <span role="status" className={styles.line}>
              {t('settings.loading')}
            </span>
          )
        ) : (
          <>
            <span className={`${styles.line} tabular`}>
              {status.version === null
                ? t('settings.updates.notInstalled')
                : t('settings.updates.version', { version: status.version })}
            </span>
            <span className={styles.line}>
              {checked === ''
                ? t('settings.updates.neverChecked')
                : t('settings.updates.checked', { when: checked })}
            </span>
            <span role="status" className={styles.line}>
              {state === null ? '' : t(`settings.updates.state.${state}`)}
              {state === 'failed' && status.error !== null && status.error !== '' && (
                <>
                  {' '}
                  {/* Rust's reason, which is in English whatever the language of the UI. */}
                  <span lang="en" className={styles.detail}>
                    {status.error}
                  </span>
                </>
              )}
            </span>
          </>
        )}
      </div>
      <div className={styles.control}>
        {status === undefined && unreadable ? (
          <button type="button" className={styles.button} onClick={onRetry} {...blurAfterPointer}>
            {t('settings.retry')}
          </button>
        ) : (
          <button
            type="button"
            className={styles.button}
            // Not `disabled`: the button keeps the focus while the check runs.
            aria-disabled={busy || status === undefined}
            onClick={check}
            {...blurAfterPointer}
          >
            {t('settings.updates.check')}
          </button>
        )}
        {refused && (
          <p role="alert" className={styles.error}>
            {t('settings.updates.checkFailed')}
          </p>
        )}
      </div>
    </div>
  );
}

export default function Updates({ only }: SectionProps) {
  const { t } = useTranslation();
  const { statuses, failed, retry, apply } = useToolStatuses();
  /** `undefined` while the diagnostics are being read, `null` where they have no libmpv. */
  const [libmpv, setLibmpv] = useState<string | null | undefined>(undefined);
  const libmpvId = `${useId()}-libmpv`;

  useEffect(() => {
    let mounted = true;
    void readVersions().then((versions) => {
      if (mounted) setLibmpv(versions.libmpv);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const toolRow = (tool: ToolId) => (
    <ToolRow
      tool={tool}
      status={statuses?.[tool]}
      unreadable={failed}
      onStatus={apply}
      onRetry={retry}
    />
  );

  return (
    <div>
      {toolRow(YT_DLP)}
      <SettingsList section={SECTION} only={only} />
      {toolRow(DENO)}
      <div className={styles.row} role="group" aria-labelledby={libmpvId} data-fact="libmpv">
        <div className={styles.text}>
          <span id={libmpvId} className={styles.name}>
            {t('settings.about.versions.libmpv')}
          </span>
          <span className={styles.hint}>{t('settings.updates.libmpvHint')}</span>
        </div>
        <div className={styles.control}>
          <span className={`${styles.value} tabular`}>
            {libmpv === undefined ? t('settings.loading') : (libmpv ?? t('settings.about.unknown'))}
          </span>
        </div>
      </div>
    </div>
  );
}
