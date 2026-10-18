/**
 * One card of the notice stack (spec 10.1, 10.2). A file that could not be played says what
 * happened in words (`errors.playback.*`), offers "Next" where the playlist goes on, and has
 * "Details" with mpv's own word for the error and the last lines of its log. A notice of the app
 * (Ctrl+V without a link, a dropped link that was refused) is a message and Close.
 *
 * - It goes by itself after 8 s. The clock is held while someone is dealing with the card: the
 *   pointer is over it, the focus is in it, or its details are open (a card that is being read, or
 *   copied from, must not vanish); the 8 s start anew when that ends.
 * - It never takes the focus: it can be reached with Tab. Esc on a focused card closes it, and the
 *   key is handled here (`preventDefault`), so it does not go on to mpv, where it would leave
 *   fullscreen. When a card that holds the focus closes, the focus goes back to where it came from.
 * - The text of the card is a live region: `alert` (assertive) for something that failed, `status`
 *   (polite) for a hint. A failed file is an interruption the user asked for ("play this") and
 *   did not get, so it is read at once; the hint about the clipboard waits for the reader.
 * - "Next" is offered while the playlist has an entry after the current one. mpv has already moved
 *   on by itself when the card shows, so this is a way to skip that one too, not to leave the
 *   broken file.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type FocusEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../input/forward';
import { playerCommand } from '../ipc/commands';
import Icon, { CHEVRON_DOWN, CLOSE, INFO, WARNING } from '../shell/Icon';
import {
  NOTICE_MS,
  useNoticeStore,
  type Notice,
  type PlaybackNotice,
} from '../state/noticeStore';
import { selectPlaylist, usePlayerStore, type PlayerProps } from '../state/playerStore';
import styles from './ErrorCards.module.css';

export interface ErrorCardProps {
  notice: Notice;
}

/** Whether the playlist has an entry after the one that is current. */
export function hasFollowingEntry(props: PlayerProps): boolean {
  const list = selectPlaylist(props);
  const current = list.findIndex((item) => item.current);
  return current >= 0 && current < list.length - 1;
}

/** The lines of the details: mpv's word for the error, then the log, oldest first. */
export function detailLines(notice: PlaybackNotice): string[] {
  const log = notice.lines.map((line) => `[${line.prefix}] ${line.text.trim()}`);
  return notice.error !== null && notice.error !== '' ? [`[mpv] ${notice.error}`, ...log] : log;
}

const warn = (what: string) => (error: unknown) => {
  console.warn(what, error);
};

/** Whether `target` (the other end of a focus change) is in `card`. */
const within = (card: HTMLElement, target: EventTarget | null): boolean =>
  target instanceof Node && card.contains(target);

export default function ErrorCard({ notice }: ErrorCardProps) {
  const { t } = useTranslation();
  const dismiss = useNoticeStore((state) => state.dismiss);
  const playback = notice.kind === 'playback';
  const hasNext = usePlayerStore((state) => playback && hasFollowingEntry(state.props));
  const [expanded, setExpanded] = useState(false);
  const [pointerOver, setPointerOver] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const card = useRef<HTMLLIElement>(null);
  /** What had the focus before it came into the card. */
  const cameFrom = useRef<HTMLElement | null>(null);
  const detailsId = useId();
  const { id } = notice;

  const held = expanded || pointerOver || focusInside;
  useEffect(() => {
    if (held) return undefined;
    const timer = setTimeout(() => {
      dismiss(id);
    }, NOTICE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [held, id, dismiss]);

  const close = () => {
    // Only for a card that holds the focus: a click with the pointer has let go of it already.
    const element = card.current;
    if (element && within(element, document.activeElement)) {
      const back = cameFrom.current;
      if (back?.isConnected) back.focus();
    }
    dismiss(id);
  };

  const next = () => {
    playerCommand({ type: 'playlistNext' }).catch(warn('player_command'));
    close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.key !== 'Escape') return;
    // Handled: the key does not go on to mpv.
    e.preventDefault();
    close();
  };

  const onFocus = (e: FocusEvent<HTMLLIElement>) => {
    if (!within(e.currentTarget, e.relatedTarget)) {
      cameFrom.current = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
    }
    setFocusInside(true);
  };

  const onBlur = (e: FocusEvent<HTMLLIElement>) => {
    if (!within(e.currentTarget, e.relatedTarget)) setFocusInside(false);
  };

  const tone = notice.kind === 'playback' ? 'alert' : notice.tone;
  const title =
    notice.kind === 'playback'
      ? notice.name !== ''
        ? t('errors.playback.title', { name: notice.name })
        : t('errors.playback.titleUnknown')
      : null;
  const lines = notice.kind === 'playback' ? detailLines(notice) : [];

  return (
    <li
      ref={card}
      className={styles.card}
      data-kind={notice.kind}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      onPointerEnter={() => {
        setPointerOver(true);
      }}
      onPointerLeave={() => {
        setPointerOver(false);
      }}
    >
      <div className={styles.row}>
        <span className={styles.icon} data-tone={tone}>
          <Icon path={tone === 'alert' ? WARNING : INFO} />
        </span>
        <div className={styles.text} role={tone === 'alert' ? 'alert' : 'status'}>
          {title !== null && <p className={styles.title}>{title}</p>}
          <p className={styles.message}>{t(notice.message)}</p>
        </div>
        <button
          type="button"
          className={styles.close}
          aria-label={t('errors.close')}
          title={t('errors.close')}
          onClick={close}
          {...blurAfterPointer}
        >
          <Icon path={CLOSE} />
        </button>
      </div>
      {playback && (
        <div className={styles.actions}>
          {hasNext && (
            <button type="button" className={styles.action} onClick={next} {...blurAfterPointer}>
              {t('player.next')}
            </button>
          )}
          <button
            type="button"
            className={styles.action}
            aria-expanded={expanded}
            aria-controls={expanded ? detailsId : undefined}
            onClick={() => {
              setExpanded((open) => !open);
            }}
            {...blurAfterPointer}
          >
            {t('errors.details')}
            <span className={styles.chevron} data-open={expanded}>
              <Icon path={CHEVRON_DOWN} />
            </span>
          </button>
        </div>
      )}
      {expanded && (
        <div id={detailsId} className={styles.log}>
          {lines.length > 0 ? (
            lines.map((line, index) => (
              <p key={index} className={styles.line}>
                {line}
              </p>
            ))
          ) : (
            <p className={styles.line}>{t('errors.noDetails')}</p>
          )}
        </div>
      )}
    </li>
  );
}
