/**
 * A delay (subtitles, audio) with a button to take a step off it and one to add a step, and the
 * value between them (`+0.3 s`). The step is the caller's: 0.1 s for subtitles, 0.05 s for audio.
 *
 * mpv's answer takes a moment, so the value shown (and the next step) is the one the user set until
 * mpv reports it (`useSettled`): two quick presses are two steps.
 */

import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { formatNumber } from '../i18n/format';
import Icon, { MINUS, PLUS } from '../shell/Icon';
import styles from './Panel.module.css';
import { useSettled } from './useSettled';

/** mpv takes a delay of up to this many seconds either way (Rust checks it too). */
export const DELAY_LIMIT_S = 600;

/** A delay held to ±`DELAY_LIMIT_S`. */
export function clampDelay(seconds: number): number {
  return Math.min(DELAY_LIMIT_S, Math.max(-DELAY_LIMIT_S, seconds));
}

/**
 * The delay one step from `seconds`, `direction` 1 for later and -1 for earlier. Rounded to
 * thousandths, so that 0.1 steps do not drift (0.30000000000000004).
 */
export function stepDelay(seconds: number, direction: 1 | -1, step: number): number {
  return clampDelay(Math.round((seconds + direction * step) * 1000) / 1000);
}

/** A delay as the user reads it: `+0.3`, `-0.05`, `0.0` (without the unit). */
export function formatDelay(seconds: number): string {
  return formatNumber(seconds, {
    signDisplay: 'exceptZero',
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  });
}

export interface DelayStepperProps {
  /** What the delay is called: "Delay". */
  label: string;
  /** The delay mpv reports, seconds. */
  value: number;
  /** What a press adds or takes off, seconds. */
  step: number;
  /** The delay to set, seconds. */
  onChange: (seconds: number) => void;
}

export default function DelayStepper({ label, value, step, onChange }: DelayStepperProps) {
  const { t } = useTranslation();
  const labelId = useId();
  const [shown, setShown] = useSettled(value);

  const press = (direction: 1 | -1) => {
    const next = stepDelay(shown, direction, step);
    setShown(next);
    onChange(next);
  };

  const stepText = formatNumber(step);
  return (
    <div role="group" aria-labelledby={labelId} className={styles.row}>
      <span id={labelId} className={styles.label}>
        {label}
      </span>
      <button
        type="button"
        className={styles.step}
        aria-label={t('panels.delay.decrease', { step: stepText })}
        onClick={() => {
          press(-1);
        }}
      >
        <Icon path={MINUS} />
      </button>
      <output className={`${styles.value} tabular`}>
        {t('panels.delay.value', { value: formatDelay(shown) })}
      </output>
      <button
        type="button"
        className={styles.step}
        aria-label={t('panels.delay.increase', { step: stepText })}
        onClick={() => {
          press(1);
        }}
      >
        <Icon path={PLUS} />
      </button>
    </div>
  );
}
