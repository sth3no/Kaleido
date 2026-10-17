/**
 * The bubble above the seekbar while the pointer is on it (spec 8.4): the preview of the frame
 * under the pointer, drawn from thumbfast's picture, and the time. It is glass over the video, so it
 * is one of the regions the shader blurs.
 *
 * The pictures come from Rust: the bubble asks nothing itself (the seekbar asks with
 * `thumb_request`); when `player:thumb` says a new one is stored it fetches it with `thumb_get`
 * and draws it. It shows only the time until the first one has come, and never a picture of
 * another place: the picture goes when the pointer leaves.
 */

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { glassRegions, useGlassRegion } from '../glass/useGlassRegion';
import { thumbGet } from '../ipc/commands';
import { onThumb } from '../ipc/events';
import { listenTo } from '../ipc/listen';
import type { ThumbFrame } from '../ipc/types';
import { formatTime } from '../i18n/format';
import glass from '../theme/glass.module.css';
import { readZoomFrame, toWindowBox } from '../theme/zoom';
import styles from './ThumbBubble.module.css';

/** Air between the bubble and the edge of the window, px. */
export const BUBBLE_MARGIN_PX = 8;

export interface ThumbHover {
  /** Where on the bar the pointer is, 0 (start) to 1 (end). */
  fraction: number;
  /** The time there, seconds. */
  seconds: number;
}

/**
 * Where the middle of a bubble `width` wide goes so that it is under the pointer (`center`) but
 * inside `min` to `max` (all in px of the window).
 */
export function clampCenter(center: number, width: number, min: number, max: number): number {
  const half = width / 2;
  // A window too narrow for the bubble: its middle.
  if (max - min < width) return (min + max) / 2;
  return Math.min(max - half, Math.max(min + half, center));
}

/**
 * Draws a preview on the canvas, which takes its size. `false` when there is no 2D context. The
 * pixels are drawn where they are: the frame is a view of the bytes `thumb_get` returned, and
 * nothing else holds them.
 */
export function drawFrame(canvas: HTMLCanvasElement, frame: ThumbFrame): boolean {
  const context = canvas.getContext('2d');
  if (!context) return false;
  canvas.width = frame.width;
  canvas.height = frame.height;
  context.putImageData(new ImageData(frame.rgba, frame.width, frame.height), 0, 0);
  return true;
}

export interface ThumbBubbleProps {
  /** The place under the pointer; `null` while the pointer is not on the bar. */
  hover: ThumbHover | null;
}

function ThumbBubble({ hover }: ThumbBubbleProps) {
  const bubble = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  /** The size of the picture in CSS px; `null` while there is none to show. */
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const shown = hover !== null;
  const shownNow = useRef(shown);
  /** The latest fetch: a fetch that is not the latest when it comes back is out of date. */
  const fetchCount = useRef(0);
  useGlassRegion(bubble);

  useEffect(() => {
    shownNow.current = shown;
    // A picture of the last place does not wait for the next hover.
    if (!shown) {
      fetchCount.current += 1;
      setSize(null);
    }
  }, [shown]);

  useEffect(
    () =>
      listenTo(
        onThumb,
        () => {
          // Nobody is looking: the picture is not fetched, and the pointer asks again where it comes back.
          if (!shownNow.current) return;
          fetchCount.current += 1;
          const mine = fetchCount.current;
          thumbGet().then(
            (frame) => {
              const target = canvas.current;
              if (mine !== fetchCount.current || !shownNow.current || !frame || !target) return;
              if (!drawFrame(target, frame)) return;
              const scale = window.devicePixelRatio || 1;
              setSize({ w: frame.width / scale, h: frame.height / scale });
            },
            (error: unknown) => {
              console.warn('thumb_get', error);
            },
          );
        },
        'player:thumb',
      ),
    [],
  );

  // Under the pointer, but not beyond the window. A move changes no size and starts no transition:
  // the glass under the bubble is measured again by hand.
  useLayoutEffect(() => {
    const element = bubble.current;
    const bar = element?.parentElement;
    if (!hover || !element || !bar) return;
    // In px of the window at any UI scale, as the bar is read where it is dragged (Seekbar.tsx).
    const frame = readZoomFrame();
    const track = toWindowBox(bar.getBoundingClientRect(), frame);
    const width = toWindowBox(element.getBoundingClientRect(), frame).width;
    const center = clampCenter(
      track.left + hover.fraction * track.width,
      width,
      BUBBLE_MARGIN_PX,
      window.innerWidth - BUBBLE_MARGIN_PX,
    );
    // As a share of the bar: right at any UI scale.
    element.style.left = `${track.width > 0 ? ((center - track.left) / track.width) * 100 : 0}%`;
    glassRegions.schedule();
  }, [hover, size]);

  return (
    <div
      ref={bubble}
      className={`${glass.glass} ${styles.bubble}`}
      data-shown={shown}
      aria-hidden
    >
      <canvas
        ref={canvas}
        className={styles.picture}
        style={size ? { width: size.w, height: size.h } : { display: 'none' }}
      />
      <span className={`${styles.time} tabular`}>{formatTime(hover?.seconds ?? 0)}</span>
    </div>
  );
}

/** The seekbar draws every frame; the bubble only when the pointer has moved. */
export default memo(ThumbBubble);
