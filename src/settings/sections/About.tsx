/**
 * About (spec 8.10, 11.6):
 *
 * - The versions of Kaleido (`getVersion`), libmpv and FFmpeg (the lines of the diagnostics, which
 *   Rust cleans of paths and links). One that cannot be found out says so.
 * - The way to the sources, which the GPL asks for: the releases of Kaleido (with the tag of the
 *   sources of each) and the libmpv build Kaleido ships. The UI names the page and Rust opens it
 *   (`system_open_source`): it has no way to open an address of its own.
 * - The logs folder, and the diagnostics on the clipboard for a bug report. Copying can fail (another
 *   program holds the clipboard): Rust rejects with a message, the page shows it, and a success is
 *   told too, in the page.
 * - A note that a screenshot a plugin asks for with the `screenshot` command has the glass in it
 *   (Kaleido's own shortcuts leave it out, spec 8.2).
 * - The licenses of the third-party software, with a search. Their full texts come later (M4).
 *
 * The list of licenses scrolls inside the page. It can take the focus, and the arrows, Page Up and
 * Down, Home and End scroll it (and say so with `preventDefault`, so that mpv does not also get them).
 */

import { getVersion } from '@tauri-apps/api/app';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../../input/forward';
import {
  systemCopyDiagnostics,
  systemDiagnostics,
  systemLicenses,
  systemOpenLogs,
  systemOpenSource,
} from '../../ipc/commands';
import type { SourcePage } from '../../ipc/types';
import { filterLicenses, parseVersions, type Versions } from '../about';
import ListError from '../fields/ListError';
import { useRustList } from '../fields/useRustList';
import styles from './About.module.css';

/** What the page tells about the last thing the buttons did: a text, and whether it went wrong. */
interface Notice {
  failed: boolean;
  key: string;
  params?: Record<string, string>;
}

interface Facts extends Versions {
  kaleido: string | null;
}

/** The text of a reason a promise was rejected with, if it has one. */
function reasonOf(reason: unknown): string | null {
  if (typeof reason === 'string' && reason.trim() !== '') return reason.trim();
  if (reason instanceof Error && reason.message.trim() !== '') return reason.message.trim();
  return null;
}

/** The versions the page lists, in order. */
const FACT_NAMES = ['kaleido', 'libmpv', 'ffmpeg'] as const;

/** How far an arrow key scrolls the list of licenses, px. */
const SCROLL_LINE = 40;

export default function About() {
  const { t } = useTranslation();
  /** `null` while the versions are being read. */
  const [facts, setFacts] = useState<Facts | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [copying, setCopying] = useState(false);
  const [query, setQuery] = useState('');
  const licenses = useRustList(systemLicenses, 'system_licenses');

  useEffect(() => {
    let mounted = true;
    const kaleido = (async () => {
      try {
        const version = await getVersion();
        return typeof version === 'string' && version !== '' ? version : null;
      } catch (error) {
        console.warn('cannot read the version of Kaleido', error);
        return null;
      }
    })();
    const versions = (async (): Promise<Versions> => {
      try {
        const text = await systemDiagnostics();
        return parseVersions(typeof text === 'string' ? text : '');
      } catch (error) {
        console.warn('cannot read the versions in the diagnostics', error);
        return { libmpv: null, ffmpeg: null };
      }
    })();
    void Promise.all([kaleido, versions]).then(([version, rest]) => {
      if (mounted) setFacts({ kaleido: version, ...rest });
    });
    return () => {
      mounted = false;
    };
  }, []);

  const copy = () => {
    setCopying(true);
    setNotice(null);
    systemCopyDiagnostics().then(
      () => {
        setNotice({ failed: false, key: 'settings.about.copied' });
        setCopying(false);
      },
      (reason: unknown) => {
        console.warn('cannot copy the diagnostics', reason);
        setNotice({
          failed: true,
          key: 'settings.about.copyFailed',
          params: { reason: reasonOf(reason) ?? t('errors.generic') },
        });
        setCopying(false);
      },
    );
  };

  /** Runs a button that opens something in Rust; the page says so when Rust cannot even be asked. */
  const open = (what: string, run: () => Promise<unknown>) => {
    setNotice(null);
    run().catch((reason: unknown) => {
      console.warn(`cannot open ${what}`, reason);
      setNotice({ failed: true, key: 'settings.about.openFailed' });
    });
  };

  const openSource = (page: SourcePage) => {
    open(`the sources of ${page}`, () => systemOpenSource(page));
  };

  const shown = useMemo(
    () => (licenses.items === null ? [] : filterLicenses(licenses.items, query)),
    [licenses.items, query],
  );
  const searching = query.trim() !== '';

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const list = e.currentTarget;
    if (e.key === 'ArrowDown') list.scrollTop += SCROLL_LINE;
    else if (e.key === 'ArrowUp') list.scrollTop -= SCROLL_LINE;
    else if (e.key === 'PageDown') list.scrollTop += list.clientHeight * 0.9;
    else if (e.key === 'PageUp') list.scrollTop -= list.clientHeight * 0.9;
    else if (e.key === 'Home') list.scrollTop = 0;
    else if (e.key === 'End') list.scrollTop = list.scrollHeight;
    else return;
    // Handled here: mpv does not get the key too (the arrows seek).
    e.preventDefault();
  };

  /** A version as the page says it: still being read (`undefined`), not found out (`null`), or the version. */
  const said = (value: string | null | undefined) =>
    value === undefined ? t('settings.loading') : (value ?? t('settings.about.unknown'));

  return (
    <div className={styles.page}>
      <dl className={styles.facts}>
        {FACT_NAMES.map((name) => (
          <div key={name} className={styles.fact}>
            <dt className={styles.factName}>{t(`settings.about.versions.${name}`)}</dt>
            <dd className={`${styles.factValue} tabular`}>{said(facts?.[name])}</dd>
          </div>
        ))}
      </dl>

      <p className={styles.note}>{t('settings.about.screenshotNote')}</p>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            open('the logs folder', systemOpenLogs);
          }}
          {...blurAfterPointer}
        >
          {t('settings.about.openLogs')}
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={copying}
          onClick={copy}
          {...blurAfterPointer}
        >
          {t('settings.about.copyDiagnostics')}
        </button>
      </div>
      <p role="status" className={styles.status}>
        {notice !== null && !notice.failed ? t(notice.key, notice.params) : ''}
      </p>
      {notice?.failed === true && (
        <p role="alert" className={styles.error}>
          {t(notice.key, notice.params)}
        </p>
      )}

      <h3 className={styles.heading}>{t('settings.about.sources.title')}</h3>
      <p className={styles.note}>{t('settings.about.sources.text')}</p>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            openSource('kaleido');
          }}
          {...blurAfterPointer}
        >
          {t('settings.about.sources.kaleido')}
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            openSource('libmpv');
          }}
          {...blurAfterPointer}
        >
          {t('settings.about.sources.libmpv')}
        </button>
      </div>

      <h3 className={styles.heading}>{t('settings.about.licenses.title')}</h3>
      <p className={styles.note}>{t('settings.about.licenses.note')}</p>
      {licenses.failed ? (
        <ListError onRetry={licenses.retry} />
      ) : licenses.items === null ? (
        <p className={styles.note}>{t('settings.loading')}</p>
      ) : (
        <>
          <div role="search">
            <input
              type="search"
              className={styles.search}
              value={query}
              aria-label={t('settings.about.licenses.search')}
              placeholder={t('settings.about.licenses.search')}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query !== '') {
                  // Handled: the search is cleared, and Esc does not go on to mpv (fullscreen).
                  e.preventDefault();
                  setQuery('');
                }
              }}
            />
          </div>
          <p role="status" className={styles.status}>
            {!searching
              ? t('settings.about.licenses.count', { total: shown.length })
              : shown.length === 0
                ? t('settings.about.licenses.none', { query: query.trim() })
                : t('settings.search.found', { total: shown.length })}
          </p>
          {shown.length > 0 && (
            <div
              role="region"
              tabIndex={0}
              className={styles.licenses}
              aria-label={t('settings.about.licenses.list')}
              onKeyDown={onListKeyDown}
            >
              <ul className={styles.licenseList}>
                {shown.map((entry, index) => (
                  <li key={`${entry.name}@${entry.version}#${index}`} className={styles.license}>
                    <span className={styles.licenseName}>
                      {entry.name}
                      <span className={`${styles.licenseVersion} tabular`}>{entry.version}</span>
                    </span>
                    <span className={styles.licenseId}>{entry.license}</span>
                    <span className={styles.licenseUrl}>{entry.url}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
