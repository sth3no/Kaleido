/**
 * The loading title (spec 8.5, point 3): while a file loads, or the network holds playback back,
 * the player shows what is coming and a sign that it is busy, in the middle of the window.
 *
 * - Loading: mpv is not idle (`idle-active` is `false`) and the file is not loaded yet, which is
 *   between the start of a file (or the end of the one before it, `end-file` clears `loaded`) and
 *   `player:file-loaded`. There is no video yet, and no controls island either (PlayerPage).
 * - Buffering: `paused-for-cache`, mpv's wait for the network while a file plays.
 *
 * The name is mpv's `media-title`; for a link, until mpv knows a title, the host from the playlist
 * entry (a path of a link tells little). mpv answers `media-title` at once, with the tail of the
 * address (`watch?v=abc`) when it has no title: that counts as no title (`knownTitle`). Paths show
 * without the `\\?\` of long ones.
 *
 * It is invisible for its first quarter of a second (a transition with a delay), so that a local
 * file that opens at once does not flash it. It then fades in, and fades out when the wait is over.
 * The place is a live region that is always in the page, polite, so that a screen reader says what
 * is loading. Over a playing video (buffering) it is glass the shader blurs; before the video there
 * is nothing to blur (the page is opaque until a file is loaded).
 */

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { glassRegions, useGlassRegion } from '../glass/useGlassRegion';
import {
  selectIdle,
  usePlayerStore,
  type PlayerProps,
  type PlayerState,
} from '../state/playerStore';
import glass from '../theme/glass.module.css';
import { currentEntryName, knownTitle } from './entryName';
import styles from './LoadingTitle.module.css';
import { useLinger } from './useAutohide';

/** A little more than the capsule's fade (`--k-motion-fast`, 150 ms). */
export const LOADING_FADE_MS = 200;

export type Waiting = 'loading' | 'buffering';

/** What the player waits for now, or `null`. */
export function selectWaiting({ props, loaded }: Pick<PlayerState, 'props' | 'loaded'>): Waiting | null {
  if (props['idle-active'] === false && !loaded) return 'loading';
  // A `paused-for-cache` that stays after the file has gone says nothing.
  if (props['paused-for-cache'] === true && !selectIdle(props)) return 'buffering';
  return null;
}

/** mpv's `media-title` where it is a title, else the current playlist entry (the host of a link). */
export function loadingName(props: PlayerProps): string {
  return knownTitle(props) || currentEntryName(props);
}

export default function LoadingTitle() {
  const { t } = useTranslation();
  const waiting = usePlayerStore(selectWaiting);
  const name = usePlayerStore((state) => loadingName(state.props));
  const loaded = usePlayerStore((state) => state.loaded);
  const capsule = useRef<HTMLDivElement>(null);

  // What the capsule says stays what it was while it fades out (`waiting` is `null` by then).
  const [said, setSaid] = useState<Waiting>('loading');
  if (waiting !== null && waiting !== said) setSaid(waiting);
  const present = useLinger(waiting !== null, LOADING_FADE_MS);

  // Over a video only: before a file is loaded the page is opaque and there is nothing to blur.
  useGlassRegion(capsule, undefined, present && loaded);

  return (
    <div className={styles.layer} role="status" aria-live="polite" aria-atomic>
      {present && (
        <div
          ref={capsule}
          className={`${glass.glass} ${styles.capsule}`}
          data-shown={waiting !== null}
          data-waiting={said}
          // Measured again when the fade is over (see Indicator.tsx).
          onTransitionEnd={() => {
            glassRegions.schedule();
          }}
        >
          <span className={styles.spinner} aria-hidden />
          <span className={styles.text}>
            {name !== '' && (
              <span className={styles.name} title={name}>
                {name}
              </span>
            )}
            <span className={styles.state}>
              {t(said === 'loading' ? 'player.loading' : 'player.buffering')}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
