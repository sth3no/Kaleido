/**
 * A number in a range: the browser's own slider (arrows, Home, End, PageUp and PageDown, and the
 * name and value that screen readers say) with its value written beside it.
 *
 * What is saved, and when:
 * - Dragged with the pointer, nothing is saved on the way: the thumb and the number move, and the
 *   value where the pointer is let go is saved once.
 * - Moved with a key, every step is a change. A step is saved at once, but not more often than
 *   every `SAVE_THROTTLE_MS` while the key is held down; the last one goes when the key is let go,
 *   so that the number shown is the number saved and Rust is not asked for every step.
 * - Set by something that is neither (a screen reader), it is saved at once.
 * A value held back also goes when the page closes.
 *
 * `onPreview` is told the value the slider shows, also while it is dragged and nothing is saved yet
 * (the appearance's preview follows the thumb). With `percent` the range is a fraction (0.3 to 0.95)
 * that is written as a percentage (30 to 95 %).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useTranslation } from 'react-i18next';

import { formatNumber } from '../../i18n/format';
import { blurAfterPointer } from '../../input/forward';
import panel from '../../panels/Panel.module.css';
import { throttle } from '../../player/throttle';
import { cleanNumber, decimalsOf } from '../values';
import styles from './Fields.module.css';
import type { FieldProps } from './FieldProps';

/** Saves of a slider moved by a key go at most this often while the key is held, ms. */
export const SAVE_THROTTLE_MS = 120;

export interface SliderProps extends FieldProps<number> {
  min: number;
  max: number;
  step: number;
  /** The key of a text with a `{{value}}` in it (`{{value}}%`); left out, the number stands alone. */
  unitKey?: string;
  /** The range is a fraction, written as a percentage. */
  percent?: boolean;
}

export default function Slider({
  id,
  labelId,
  value,
  onChange,
  describedBy,
  invalid,
  disabled,
  min,
  max,
  step,
  unitKey,
  percent = false,
  onPreview,
}: SliderProps) {
  const { t } = useTranslation();
  /** Where the thumb is while the user moves it, ahead of what has been saved. */
  const [moving, setMoving] = useState<number | null>(null);
  /** What is holding the slider: the pointer (not saved on the way) or a key (saved by steps). */
  const held = useRef<'pointer' | 'key' | null>(null);
  /** The newest place the thumb was moved to. */
  const latest = useRef<number | null>(null);
  const stopWatching = useRef<AbortController | null>(null);
  const current = useRef({ value, onChange, onPreview });
  useLayoutEffect(() => {
    current.current = { value, onChange, onPreview };
  });

  const send = useMemo(
    () =>
      throttle((next: number) => {
        current.current.onChange(next);
      }, SAVE_THROTTLE_MS),
    [],
  );

  /** The pointer or the key is let go: what was held back is saved, and the saved value is shown. */
  const release = useCallback(() => {
    const was = held.current;
    const where = latest.current;
    held.current = null;
    latest.current = null;
    if (was === 'pointer' && where !== null && where !== current.current.value) send(where);
    send.flush();
    setMoving(null);
  }, [send]);

  // What was held back goes before the page closes; the pointer's release is no longer watched.
  useEffect(
    () => () => {
      send.flush();
      stopWatching.current?.abort();
    },
    [send],
  );

  const onPointerDown = () => {
    held.current = 'pointer';
    // The pointer may be let go away from the slider.
    stopWatching.current?.abort();
    const abort = new AbortController();
    stopWatching.current = abort;
    window.addEventListener('pointerup', release, { once: true, signal: abort.signal });
    window.addEventListener('pointercancel', release, { once: true, signal: abort.signal });
  };

  const moved = (raw: string) => {
    const next = Number(raw);
    if (!Number.isFinite(next)) return;
    const place = cleanNumber(next, min, max, step);
    latest.current = place;
    setMoving(place);
    if (held.current === 'pointer') return;
    send(place);
    // No pointer or key behind it (a screen reader set it): nothing will come to let it go.
    if (held.current === null) release();
  };

  const shown = cleanNumber(moving ?? value, min, max, step);
  // A step of 0.05 as a percentage has no decimals; the digits of the fraction beyond two are the percentage's.
  const formatted = percent
    ? formatNumber(shown * 100, { maximumFractionDigits: Math.max(0, decimalsOf(step) - 2) })
    : formatNumber(shown, { maximumFractionDigits: decimalsOf(step) });
  const text = unitKey === undefined ? formatted : t(unitKey, { value: formatted });

  // What the slider shows is what the preview follows: the thumb while it is moved, then the value
  // being saved (the field holds it), then the stored one.
  useEffect(() => {
    current.current.onPreview?.(shown);
  }, [shown]);
  const fill = max > min ? (shown - min) / (max - min) : 0;

  return (
    <div className={styles.slider}>
      <input
        id={id}
        type="range"
        className={panel.range}
        style={{ '--fill': fill } as CSSProperties}
        min={min}
        max={max}
        step={step}
        value={shown}
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-invalid={invalid ? true : undefined}
        aria-valuetext={text}
        disabled={disabled}
        onChange={(e) => {
          moved(e.target.value);
        }}
        onPointerDown={onPointerDown}
        onKeyDown={() => {
          held.current ??= 'key';
        }}
        onKeyUp={release}
        onBlur={release}
        {...blurAfterPointer}
      />
      {/* Not a live region (an output is one): the slider's aria-valuetext says the value. */}
      <output htmlFor={id} className={`${styles.sliderValue} tabular`} aria-live="off">
        {text}
      </output>
    </div>
  );
}
