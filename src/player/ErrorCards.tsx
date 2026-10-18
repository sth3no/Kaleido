/**
 * The stack of notice cards at the top right (spec 10.1, 10.2; Ruling R40), above every view: the
 * start screen, the player and the settings. It is mounted once, by the app (`App.tsx` hands it to
 * the shell), and not by `PlayerPage`, because a file that fails to open as the only one of the
 * playlist leaves the player for the start screen as soon as mpv is idle again, and the card has
 * to be there for that too.
 *
 * What makes a card (`state/noticeStore.ts` holds them, at most three, the newest on top):
 *
 * - `player:end-file` with `reason: "error"`: a playback card. The text comes from mpv's error
 *   string (`playbackError.ts`), the name from the current playlist entry, and the details from the
 *   tail of mpv's log (`logTail`). The log lines that explain the failure may arrive after
 *   `end-file`, so for a moment longer the card also takes the lines that come in.
 * - `system:paste-empty` (Ctrl+V found no link) while the view is not the start screen. The start
 *   screen answers that itself, with its paste field (`HomeScreen.tsx`), and is mounted exactly
 *   while the view is `home`; so the two never both react.
 * - `pushAppNotice` from elsewhere: a dropped link that Rust refused (`home/useDrop.ts`).
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

import { glassRegions, useGlassRegion } from '../glass/useGlassRegion';
import { onPasteEmpty } from '../ipc/events';
import { listenTo } from '../ipc/listen';
import { selectView } from '../shell/view';
import { DETAIL_LINES, pushAppNotice, useNoticeStore } from '../state/noticeStore';
import { usePlayerStore } from '../state/playerStore';
import { useUiStore } from '../state/uiStore';
import glass from '../theme/glass.module.css';
import { currentEntryName } from './entryName';
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
        // mpv has not moved on to the next entry yet (that property change follows `end-file`):
        // the current entry is the one that failed.
        const id = useNoticeStore.getState().push({
          kind: 'playback',
          message: playbackErrorKey(end.error),
          name: currentEntryName(state.props),
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
}

export default function ErrorCards() {
  const { t } = useTranslation();
  useNoticeFeed();
  const notices = useNoticeStore((state) => state.notices);
  const loaded = usePlayerStore((state) => state.loaded);
  const page = useUiStore((state) => state.page);
  const stack = useRef<HTMLUListElement>(null);
  useGlassRegion(stack, undefined, loaded && page === 'player' && notices.length > 0);

  if (notices.length === 0) return null;
  return (
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
  );
}
