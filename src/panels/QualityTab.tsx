/**
 * The Quality tab of quick settings (spec 8.5, point 2), for a link: the qualities yt-dlp lists
 * for it (`streams/quality.ts`), made from what Rust probes while the link loads
 * (`streams/streamStore.ts`).
 *
 * - Ready: a radio group, "Automatic" first. The one marked is Rust's `chosen` (`null` is
 *   Automatic). A click sends the choice, and the option shows a ring (with the same words in a
 *   live region under the list) for the round trip of the command. A choice is a reload like any
 *   open (Ruling R13): when Rust has taken it, the panel closes at once, the player shows its
 *   loading title and goes on at the same position, and the panel shows the new quality marked when
 *   it is opened again. When Rust refuses it the panel stays open and the option says so.
 * - Loading: it says so. Failed: it says why, in the words of the class of the error
 *   (`errors.stream.*`, which the error cards use too); a failure that has no class shows the last
 *   line yt-dlp wrote.
 *
 * The arrows, Home and End move the focus through the list and say so with `preventDefault` (mpv
 * does not also get them); Enter and Space choose, as a click does. The focus does not choose on
 * the way, as in the track lists: a choice reloads the link, and an arrow held down would do it for
 * every step. The option that is marked is the one Tab reaches, and the one the panel opens on.
 */

import { useMemo, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { StreamInfo } from '../ipc/types';
import Icon, { CHECK } from '../shell/Icon';
import { streamErrorKey } from '../shell/notices/streamError';
import { useUiStore } from '../state/uiStore';
import { qualityOptions, type QualityOption } from '../streams/quality';
import {
  usePendingQuality,
  useRefusedQuality,
  useStreamFormats,
  useStreamStore,
} from '../streams/streamStore';
import styles from './Panel.module.css';
import quality from './QualityTab.module.css';

interface QualityListProps {
  info: StreamInfo;
  /** The `ytdl-format` the link plays with; `null` for the default. */
  chosen: string | null;
}

function QualityList({ info, chosen }: QualityListProps) {
  const { t } = useTranslation();
  const pending = usePendingQuality();
  const refused = useRefusedQuality();
  const select = useStreamStore((state) => state.select);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  // The labels change with the formats and the language, not with every render of the panel.
  const options = useMemo(() => qualityOptions(info, t), [info, t]);

  // A `chosen` that is none of the choices (it is Rust's, and the list can change under it) marks
  // nothing rather than a choice that is not at work.
  const marked = options.findIndex((option) => option.selector === chosen);
  // What Tab reaches and the panel opens on: the marked option, or the first.
  const entry = Math.max(0, marked);

  // Rust has taken the choice: the link reloads, so quick settings have nothing more to show.
  const choose = (option: QualityOption) => {
    void select(option).then((taken) => {
      const { panel, setPanel } = useUiStore.getState();
      if (taken && panel === 'quick-settings') setPanel(null);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = buttons.current.findIndex((button) => button !== null && button === document.activeElement);
    if (index < 0 || e.ctrlKey || e.altKey || e.metaKey) return;
    const last = options.length - 1;
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(index + 1, last);
    else if (e.key === 'ArrowUp') next = Math.max(index - 1, 0);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next < 0) return;
    // Handled here: mpv does not get the arrow too.
    e.preventDefault();
    buttons.current[next]?.focus();
  };

  return (
    <>
      <div
        role="radiogroup"
        aria-label={t('panels.quality.options')}
        aria-invalid={refused !== null || undefined}
        className={styles.options}
        onKeyDown={onKeyDown}
      >
        {options.map((option, index) => {
          const isMarked = index === marked;
          const busy = pending !== null && pending.selector === option.selector;
          const isRefused = refused !== null && refused.selector === option.selector;
          return (
            <button
              key={option.id}
              ref={(element) => {
                buttons.current[index] = element;
              }}
              type="button"
              role="radio"
              className={isRefused ? `${styles.option} ${quality.refused}` : styles.option}
              aria-checked={isMarked}
              aria-busy={busy || undefined}
              data-refused={isRefused ? '' : undefined}
              tabIndex={index === entry ? 0 : -1}
              data-autofocus={index === entry ? '' : undefined}
              onClick={() => {
                choose(option);
              }}
            >
              <span className={styles.text}>
                <span className={styles.name}>{option.label}</span>
                {option.selector === null && (
                  <span className={styles.detail}>{t('panels.quality.autoDetail')}</span>
                )}
                {isRefused && <span className={styles.detail}>{t('panels.quality.refused')}</span>}
              </span>
              {busy ? (
                <span className={quality.spinner} aria-hidden />
              ) : (
                isMarked && <Icon path={CHECK} />
              )}
            </button>
          );
        })}
      </div>
      {options.length === 1 && <p className={styles.empty}>{t('panels.quality.none')}</p>}
      <p role="status" className={quality.status}>
        {pending === null ? null : t('panels.quality.switching')}
      </p>
    </>
  );
}

export default function QualityTab() {
  const { t } = useTranslation();
  const formats = useStreamFormats();

  if (formats === null || formats.state.type === 'loading') {
    return (
      <p role="status" className={styles.empty}>
        {t('panels.quality.loading')}
      </p>
    );
  }

  const { state } = formats;
  if (state.type === 'failed') {
    return (
      <>
        <p className={styles.empty}>{t('panels.quality.failed')}</p>
        <p className={styles.empty}>
          {state.error === null ? t('panels.quality.failedUnknown') : t(streamErrorKey(state.error))}
        </p>
        {state.error === null && state.message.trim() !== '' && (
          <p className={quality.message}>{state.message}</p>
        )}
      </>
    );
  }

  return <QualityList info={state.info} chosen={formats.chosen} />;
}
