/**
 * One card of the notice stack (spec 10.1, 10.2, 10.4). A file that could not be played says what
 * happened in words (`errors.playback.*`) and what happens now (Ruling R41), and has "Details" with
 * mpv's own word for the error and the last lines of its log. A notice of the app (Ctrl+V without
 * a link, a dropped link that was refused) is a message and Close. A plugin that reports errors
 * (`plugins:error`, once for a plugin in a run of the app) gets a quiet card with "Disable" and a
 * link to My plugins: the plugin keeps running, and nothing is turned off by itself. After Disable
 * the card says that this takes effect after Apply (`shell/notices/pluginNotice.ts`).
 *
 * - What happens now is Rust's word, `continues` of `player:end-file`, from the playlist as it was
 *   when the file failed. mpv goes on by itself (spec 10.2), so there is no "Next" to offer: it
 *   would skip an entry that was never seen. Where mpv goes on, the card says that playback
 *   continues with the next file; where the failure left it with nothing to play, the card offers
 *   "Open file", the way out.
 * - It goes by itself after 8 s. The clock is held while someone is dealing with the card: the
 *   pointer is over it, the focus is in it, or its details are open (a card that is being read, or
 *   copied from, must not vanish), or its action runs (Disable); the 8 s start anew when that ends.
 * - It never takes the focus: it can be reached with Tab. Esc on a focused card closes it, and the
 *   key is handled here (`preventDefault`), so it does not go on to mpv, where it would leave
 *   fullscreen. When a card that holds the focus closes, the focus goes back to where it came from.
 * - What a failure says is `role="alert"` (assertive): a failed file is an interruption of what the
 *   user asked for ("play this"), so it is read at once, and so is a plugin that could not be
 *   turned off. A hint (Ctrl+V without a link) and the card of a plugin that reports errors are
 *   not announced by their cards at all: a region that arrives with its text is announced
 *   unreliably, so the stack has a permanent polite region for them (`ErrorCards.tsx`).
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../../input/forward';
import { systemOpenDialog } from '../../ipc/commands';
import { problemText } from '../../plugins/problem';
import {
  isWorking,
  NOTICE_MS,
  useNoticeStore,
  type Notice,
  type PlaybackNotice,
} from '../../state/noticeStore';
import Icon, { CHEVRON_DOWN, CLOSE, INFO, WARNING } from '../Icon';
import styles from './ErrorCards.module.css';
import { disableFromNotice, openPlugins } from './pluginNotice';

export interface ErrorCardProps {
  notice: Notice;
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
  const playback = notice.kind === 'playback' ? notice : null;
  const plugin = notice.kind === 'plugin' ? notice : null;
  const [expanded, setExpanded] = useState(false);
  const [pointerOver, setPointerOver] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const card = useRef<HTMLLIElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  /** What had the focus before it came into the card. */
  const cameFrom = useRef<HTMLElement | null>(null);
  const detailsId = useId();
  const { id } = notice;

  // A plugin's card stays while "Disable" runs.
  const held = expanded || pointerOver || focusInside || isWorking(notice);
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

  // The dialog is the system's, and the file it returns is opened by Rust; the card has done its job.
  const openFile = () => {
    systemOpenDialog('media').catch(warn('system_open_dialog'));
    close();
  };

  // "Disable" goes from the card once it is done: the focus it had goes on to the link beside it.
  const disable = (e: MouseEvent<HTMLButtonElement>) => {
    if (!plugin || plugin.phase === 'working') return;
    const hadFocus = document.activeElement === e.currentTarget;
    void disableFromNotice(id, plugin.name).then(() => {
      if (hadFocus && useNoticeStore.getState().notices.some((other) => other.id === id)) {
        openButton.current?.focus();
      }
    });
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

  const tone =
    notice.kind === 'playback' ? 'alert' : notice.kind === 'plugin' ? 'status' : notice.tone;
  const title = playback
    ? playback.name !== ''
      ? t('errors.playback.title', { name: playback.name })
      : t('errors.playback.titleUnknown')
    : plugin
      ? t('errors.plugin.title', { name: plugin.name })
      : null;
  const lines = playback ? detailLines(playback) : [];

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
        <div className={styles.text} role={tone === 'alert' ? 'alert' : undefined}>
          {title !== null && <p className={styles.title}>{title}</p>}
          <p className={styles.message}>
            {plugin?.phase === 'off'
              ? t('errors.plugin.off', { name: plugin.name })
              : t(notice.message)}
          </p>
          {playback?.remedy === 'continues' && (
            <p className={styles.remedy}>{t('errors.playback.continues')}</p>
          )}
          {plugin?.phase === 'failed' && plugin.problem !== null && (
            <p className={styles.remedy} role="alert">
              {problemText(plugin.problem, t)}
            </p>
          )}
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
          {playback.remedy === 'open' && (
            <button type="button" className={styles.action} onClick={openFile} {...blurAfterPointer}>
              {t('home.openFile')}
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
      {plugin && (
        <div className={styles.actions}>
          {plugin.phase !== 'off' && plugin.problem?.code !== 'notFound' && (
            // Not `disabled`: the button keeps the focus while the action runs.
            <button
              type="button"
              className={styles.action}
              aria-disabled={plugin.phase === 'working'}
              onClick={disable}
              {...blurAfterPointer}
            >
              {t('errors.plugin.disable')}
            </button>
          )}
          <button
            ref={openButton}
            type="button"
            className={styles.action}
            onClick={openPlugins}
            {...blurAfterPointer}
          >
            {t('errors.plugin.open')}
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
