/**
 * The stack of notice cards at the top right (spec 10.1, 10.2; Rulings R40, R41, R42), above every
 * view: the start screen, the player and the settings. It is a layer of the shell (`App.tsx` hands
 * it to `AppShell` as `notices`) and not a part of `PlayerPage`, because a file that fails to open
 * as the only one of the playlist leaves the player for the start screen as soon as mpv is idle
 * again, and the card has to be there for that too.
 *
 * What makes a card (`state/noticeStore.ts` holds them, at most three, the newest on top):
 *
 * - `player:end-file` with `reason: "error"`: a playback card. The text comes from mpv's error
 *   string (`playbackError.ts`). The name is the file Rust says failed (`file`, the playlist entry
 *   by the id of the event), and what the card offers is Rust's `continues`: whether mpv goes on
 *   by itself (Rulings R42, R43). Rust has them from the playlist as it is when the file fails;
 *   the UI's copy of it may be older than that, so nothing here reads it, and nothing looks at
 *   the entry that is current, which has moved on. The details are the tail of mpv's log
 *   (`logTail`); the lines that explain the failure may arrive after `end-file`, so for a moment
 *   longer the card also takes the lines that come in.
 * - `system:paste-empty` (Ctrl+V found no link) while the view is not the start screen. The start
 *   screen answers that itself, with its paste field (`HomeScreen.tsx`), and is mounted exactly
 *   while the view is `home`; so the two never both react.
 * - `system:error`: something inside Kaleido failed (a panic on the mpv event thread, Ruling R53);
 *   the log says what, the card says that it happened, on every page.
 * - `plugins:error` (spec 10.4): a plugin logged its first error of this run. Rust says it once for
 *   a plugin, and the card is a quiet one, with "Disable" and a link to My plugins; nothing is
 *   turned off by itself.
 * - `pushAppNotice` from elsewhere: a dropped link that Rust refused (`home/useDrop.ts`).
 *
 * Hints (`status` notices) and the cards of plugins are announced by a live region that is always
 * in the page, not by their cards: a region that arrives together with its text is announced
 * unreliably. A failure is `role="alert"` on its card (`ErrorCard.tsx`).
 *
 * Glass: all the cards are one glass sheet and one region of the shader, not one each. The shader
 * takes at most `MAX_REGIONS` (6) regions, in the order they registered, and the title island, the
 * window island, the controls island, the seek preview and the open sidebar already use up to five
 * of them; with a region for each of three cards the indicator, which comes up for a second at a
 * time and would be the last in line, would have none. The sheet is a region only while it is up
 * over a video (before a file is loaded, or on another page, the page is opaque and there is
 * nothing to blur).
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { glassRegions, useGlassRegion } from '../../glass/useGlassRegion';
import { onPasteEmpty, onPluginsError, onSystemError } from '../../ipc/events';
import { listenTo } from '../../ipc/listen';
import { nameOfFile } from '../../player/entryName';
import {
  DETAIL_LINES,
  pushAppNotice,
  pushPluginNotice,
  useNoticeStore,
  type AppNotice,
  type PluginNotice,
} from '../../state/noticeStore';
import { usePlayerStore } from '../../state/playerStore';
import { useUiStore } from '../../state/uiStore';
import glass from '../../theme/glass.module.css';
import { selectView } from '../view';
import ErrorCard from './ErrorCard';
import styles from './ErrorCards.module.css';
import { playbackErrorKey } from './playbackError';

/** How long after `end-file` a new line of mpv's log still belongs to the failed file, ms. */
export const LOG_FOLLOW_MS = 1500;

/** Makes the cards of the events that are no card's own: see the top of the file. */
function useNoticeFeed(): void {
  useEffect(() => {
    let following: { id: number; until: number } | null = null;
    return usePlayerStore.subscribe((state, previous) => {
      const end = state.lastEnd;
      if (end !== previous.lastEnd && end?.reason === 'error') {
        const id = useNoticeStore.getState().push({
          kind: 'playback',
          message: playbackErrorKey(end.error),
          name: nameOfFile(end.file),
          // Rust read the playlist when the file failed; the UI's copy may be older.
          remedy: end.continues ? 'continues' : 'open',
          error: end.error,
          lines: state.logTail.slice(-DETAIL_LINES),
        });
        following = { id, until: Date.now() + LOG_FOLLOW_MS };
        return;
      }
      if (state.logTail !== previous.logTail && following !== null && Date.now() <= following.until) {
        const line = state.logTail.at(-1);
        if (line) useNoticeStore.getState().addLogLine(following.id, line);
      }
    });
  }, []);

  useEffect(
    () =>
      listenTo(
        onPasteEmpty,
        () => {
          // Read now, not when the effect ran: the view changes.
          if (selectView(useUiStore.getState().page, usePlayerStore.getState()) === 'home') return;
          pushAppNotice('errors.pasteEmpty', 'status');
        },
        'system:paste-empty',
      ),
    [],
  );

  // Something inside Kaleido failed (Ruling R53): the log has it, the user is told.
  useEffect(
    () =>
      listenTo(
        onSystemError,
        () => {
          pushAppNotice('errors.internal');
        },
        'system:error',
      ),
    [],
  );

  // A plugin logged its first error of this run (spec 10.4): one quiet card, with "Disable".
  useEffect(
    () =>
      listenTo(
        onPluginsError,
        ({ name }) => {
          pushPluginNotice(name);
        },
        'plugins:error',
      ),
    [],
  );
}

export default function ErrorCards() {
  const { t } = useTranslation();
  useNoticeFeed();
  const notices = useNoticeStore((state) => state.notices);
  const loaded = usePlayerStore((state) => state.loaded);
  const page = useUiStore((state) => state.page);
  const stack = useRef<HTMLUListElement>(null);
  useGlassRegion(stack, undefined, loaded && page === 'player' && notices.length > 0);

  // The newest hint or plugin card that is up. Its element is new for each notice (`key`), so that
  // the same hint pressed twice is announced twice; a plugin's card is announced again when it
  // says that the plugin is off.
  const hint = notices.find(
    (notice): notice is AppNotice | PluginNotice =>
      (notice.kind === 'app' && notice.tone === 'status') || notice.kind === 'plugin',
  );
  const hintText =
    hint === undefined
      ? ''
      : hint.kind === 'app'
        ? t(hint.message)
        : hint.phase === 'off'
          ? t('errors.plugin.off', { name: hint.name })
          : t('errors.plugin.title', { name: hint.name });

  return (
    <>
      <div className={styles.announce} role="status" aria-live="polite" aria-atomic>
        {hint && (
          <span key={hint.kind === 'plugin' && hint.phase === 'off' ? `${hint.id}-off` : hint.id}>
            {hintText}
          </span>
        )}
      </div>
      {notices.length > 0 && (
        <ul
          ref={stack}
          className={`${glass.glass} ${styles.stack}`}
          aria-label={t('errors.notices')}
          // Measured again when the sheet has come in (see Indicator.tsx).
          onTransitionEnd={() => {
            glassRegions.schedule();
          }}
        >
          {notices.map((notice) => (
            <ErrorCard key={notice.id} notice={notice} />
          ))}
        </ul>
      )}
    </>
  );
}
