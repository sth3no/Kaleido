/**
 * The timeline (spec 8.4): the time, the bar with the marks of the chapters, the length.
 *
 * - Hovering shows the bubble with the preview (`thumb_request`, at most one per 30 ms) and
 *   leaving clears it (`thumb_clear`).
 * - Dragging seeks to the nearest keyframe, at most once per 50 ms (`Seek` absolute, not exact), and
 *   the release seeks exactly, once, to where the pointer is. A drag that ends without a release
 *   (the system cancels the pointer, the capture is lost, Esc is pressed, or a move says no button
 *   is down any more) ends the same way at the last X the drag saw: the coordinates of such an
 *   event say nothing (0 for a cancel), so they are never used.
 * - With the focus the bar handles the arrows (±5 s), Home and End itself and says so with
 *   `preventDefault`, so that the keys do not also go to mpv (input/forward.ts).
 *
 * A click with the pointer gives the focus back (`blurAfterPointer`), at the end of the release, so
 * that Space and the arrows go to mpv again; a drag does not lose the focus before that.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import { formatTime } from '../i18n/format';
import { blurAfterPointer } from '../input/forward';
import { playerCommand, thumbClear, thumbRequest } from '../ipc/commands';
import type { PlayerCommand } from '../ipc/types';
import { selectChapters, selectDuration, usePlayerStore } from '../state/playerStore';
import { useInterpolatedTime } from '../state/useInterpolatedTime';
import { readZoomFrame, toWindowBox } from '../theme/zoom';
import styles from './Seekbar.module.css';
import ThumbBubble, { type ThumbHover } from './ThumbBubble';
import { throttle } from './throttle';

/** At most one preview is asked for per this long, ms. */
export const HOVER_THROTTLE_MS = 30;
/** At most one seek to a keyframe per this long while dragging, ms. */
export const DRAG_THROTTLE_MS = 50;
/** What the arrows jump, seconds. */
export const KEY_SEEK_SECONDS = 5;

/**
 * What a key does on the bar: the arrows jump ±5 s, Home goes to the start and End to the end.
 * `null` for any other key, and for a key with a modifier (Ctrl+arrow and the like are mpv's).
 */
export function seekKeyCommand(
  key: string,
  modifiers: { ctrl?: boolean; alt?: boolean; meta?: boolean; shift?: boolean } = {},
): PlayerCommand | null {
  if (modifiers.ctrl || modifiers.alt || modifiers.meta || modifiers.shift) return null;
  switch (key) {
    case 'ArrowLeft':
      return { type: 'seek', target: -KEY_SEEK_SECONDS, mode: 'relative', exact: false };
    case 'ArrowRight':
      return { type: 'seek', target: KEY_SEEK_SECONDS, mode: 'relative', exact: false };
    case 'Home':
      return { type: 'seek', target: 0, mode: 'absolute', exact: false };
    case 'End':
      return { type: 'seek', target: 100, mode: 'absolutePercent', exact: false };
    default:
      return null;
  }
}

const warn = (what: string) => (error: unknown) => {
  console.warn(what, error);
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export default function Seekbar() {
  const { t } = useTranslation();
  const duration = usePlayerStore((state) => selectDuration(state.props));
  const chapters = usePlayerStore((state) => selectChapters(state.props));
  const time = useInterpolatedTime();
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<ThumbHover | null>(null);
  /** Seconds the pointer holds while it drags; `null` when it does not. */
  const [dragTime, setDragTime] = useState<number | null>(null);
  const dragging = useRef(false);
  /** The X (client px) the drag saw last, in the press and the moves; where it ends without a release. */
  const lastX = useRef(0);
  /** The pointer that holds the drag, for letting go of it. */
  const capturedPointer = useRef<number | null>(null);
  const lastRequested = useRef<number | null>(null);
  const seekable = duration > 0;

  const requestPreview = useMemo(
    () =>
      throttle((seconds: number) => {
        thumbRequest(seconds).catch(warn('thumb_request'));
      }, HOVER_THROTTLE_MS),
    [],
  );
  const seekToKeyframe = useMemo(
    () =>
      throttle((seconds: number) => {
        playerCommand({ type: 'seek', target: seconds, mode: 'absolute', exact: false }).catch(
          warn('seek'),
        );
      }, DRAG_THROTTLE_MS),
    [],
  );

  // Nothing is asked for or seeked after the bar is gone.
  useEffect(
    () => () => {
      requestPreview.cancel();
      seekToKeyframe.cancel();
      if (lastRequested.current !== null) thumbClear().catch(warn('thumb_clear'));
    },
    [requestPreview, seekToKeyframe],
  );

  /** The place under `clientX` on the bar. */
  const placeAt = (clientX: number): ThumbHover => {
    const element = track.current;
    const box = element ? toWindowBox(element.getBoundingClientRect(), readZoomFrame()) : null;
    const fraction = box && box.width > 0 ? clamp01((clientX - box.left) / box.width) : 0;
    return { fraction, seconds: fraction * duration };
  };

  const showPreview = (place: ThumbHover) => {
    // A move that finds the same place (a sub-pixel jitter, a repeated event) changes nothing.
    setHover((previous) =>
      previous?.fraction === place.fraction && previous.seconds === place.seconds ? previous : place,
    );
    if (lastRequested.current === place.seconds) return;
    lastRequested.current = place.seconds;
    requestPreview(place.seconds);
  };

  const hidePreview = () => {
    setHover(null);
    lastRequested.current = null;
    requestPreview.cancel();
    thumbClear().catch(warn('thumb_clear'));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!seekable || e.button !== 0) return;
    try {
      // The moves and the release come here even when the pointer has left the bar.
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is gone already (a touch that ended); the drag goes on while it is over the bar.
    }
    dragging.current = true;
    capturedPointer.current = e.pointerId;
    lastX.current = e.clientX;
    const place = placeAt(e.clientX);
    setDragTime(place.seconds);
    showPreview(place);
    seekToKeyframe(place.seconds);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!seekable) return;
    // A drag with no button down: the release was never seen. It ends where the drag last was,
    // and this move is only a hover.
    if (dragging.current && e.buttons === 0) finishDrag(lastX.current);
    const place = placeAt(e.clientX);
    showPreview(place);
    if (dragging.current) {
      lastX.current = e.clientX;
      setDragTime(place.seconds);
      seekToKeyframe(place.seconds);
    }
  };

  /** The drag is over: one exact seek to `clientX`. */
  const finishDrag = (clientX: number) => {
    if (!dragging.current) return;
    dragging.current = false;
    seekToKeyframe.cancel();
    setDragTime(null);
    const { seconds } = placeAt(clientX);
    playerCommand({ type: 'seek', target: seconds, mode: 'absolute', exact: true }).catch(
      warn('seek'),
    );
  };

  /** A drag that ends with no release to say where: the last place it saw. */
  const abandonDrag = () => {
    finishDrag(lastX.current);
  };

  /** Lets go of the pointer, which ends the capture. */
  const releasePointer = () => {
    const id = capturedPointer.current;
    capturedPointer.current = null;
    if (id === null) return;
    try {
      track.current?.releasePointerCapture(id);
    } catch {
      // Not held any more.
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    // The only end whose coordinates are the pointer's: where it was let go.
    finishDrag(e.clientX);
    capturedPointer.current = null;
    blurAfterPointer.onPointerUp(e);
  };

  const onPointerLeave = () => {
    // A drag holds the pointer; the bubble goes when it lets go.
    if (!dragging.current) hidePreview();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Esc in a drag ends it where it is (the seek is made); mpv does not get the key.
    if (e.key === 'Escape' && dragging.current) {
      e.preventDefault();
      abandonDrag();
      releasePointer();
      return;
    }
    if (!seekable) return;
    const command = seekKeyCommand(e.key, {
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey,
      shift: e.shiftKey,
    });
    if (!command) return;
    // Handled here: mpv must not get the key a second time.
    e.preventDefault();
    playerCommand(command).catch(warn('seek'));
  };

  const shown = dragTime ?? time;
  const progress = seekable ? clamp01(shown / duration) : 0;
  // A film of an hour or more: both times are written with the hours.
  const long = duration >= 3600;
  const position = formatTime(shown, long);
  const length = formatTime(duration, long);
  // The sentence changes once a second, not with every frame.
  const valueText = useMemo(
    () => t('player.seek.value', { position, duration: length }),
    [t, position, length],
  );

  // The marks change with the chapters, not with every frame of the time.
  const marks = useMemo(
    () =>
      seekable
        ? chapters
            .filter((chapter) => chapter.time > 0 && chapter.time < duration)
            .map((chapter, index) => (
              <span
                key={index}
                className={styles.mark}
                style={{ left: `${(chapter.time / duration) * 100}%` }}
              />
            ))
        : null,
    [chapters, duration, seekable],
  );

  return (
    <div className={styles.seekbar}>
      <span className={`${styles.time} tabular`}>{position}</span>
      <div
        ref={track}
        className={styles.track}
        role="slider"
        tabIndex={seekable ? 0 : -1}
        aria-label={t('player.seek.label')}
        aria-orientation="horizontal"
        aria-disabled={!seekable}
        aria-valuemin={0}
        aria-valuemax={Math.floor(duration)}
        // Whole seconds: a screen reader is not told 60 times a second.
        aria-valuenow={Math.floor(shown)}
        aria-valuetext={valueText}
        style={{ '--progress': progress } as CSSProperties}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        // No release: the coordinates of these events are none (0 for a cancel), the drag's own are used.
        onPointerCancel={abandonDrag}
        onLostPointerCapture={abandonDrag}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
      >
        <div className={styles.rail}>
          <div className={styles.fill} />
          {marks}
        </div>
        <div className={styles.knob} />
        <ThumbBubble hover={hover} />
      </div>
      <span className={`${styles.time} ${styles.length} tabular`}>{length}</span>
    </div>
  );
}
