/**
 * The volume (spec 8.4): the mute button and a slider from 0 to `volume-max` (130 unless mpv says
 * otherwise) with a mark at 100, the volume the file was made at.
 *
 * The slider is the browser's own, which has the keyboard (arrows, Page Up and Down, Home and End)
 * and the screen reader's name and value for free; keys on it do not go to mpv (input/forward.ts).
 * mpv's answer takes a moment, so while the slider is used it shows the value the user set, and the
 * volume that mpv reports takes over when it is that value, or after a short wait.
 */

import { useEffect, useMemo, useState, type ChangeEvent, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../input/forward';
import { playerCommand } from '../ipc/commands';
import { selectVolume, usePlayerStore } from '../state/playerStore';
import { MUTED, VOLUME } from '../shell/Icon';
import ControlButton from './ControlButton';
import { throttle } from './throttle';
import styles from './VolumeControl.module.css';

/** mpv's `volume-max` unless it says otherwise. */
export const DEFAULT_VOLUME_MAX = 130;
/** The volume the file was made at: the mark on the slider. */
export const FULL_VOLUME = 100;
/** The volume goes to mpv at most this often while the slider moves, ms. */
export const VOLUME_THROTTLE_MS = 30;
/** How long the slider keeps the user's value when mpv does not report it (it clamped it), ms. */
const SETTLE_MS = 500;

/** `volume-max` from the properties: a number above 0, else the default. */
export function volumeMaxOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_VOLUME_MAX;
}

const warn = (error: unknown) => {
  console.warn('volume', error);
};

export default function VolumeControl() {
  const { t } = useTranslation();
  const volume = usePlayerStore((state) => selectVolume(state.props));
  const volumeMax = usePlayerStore((state) => volumeMaxOf(state.props['volume-max']));
  const muted = usePlayerStore((state) => state.props['mute'] === true);
  /** The value the user has set and mpv has not reported yet. */
  const [pending, setPending] = useState<number | null>(null);

  const sendVolume = useMemo(
    () =>
      throttle((value: number) => {
        playerCommand({ type: 'setVolume', volume: value }).catch(warn);
      }, VOLUME_THROTTLE_MS),
    [],
  );
  useEffect(
    () => () => {
      sendVolume.cancel();
    },
    [sendVolume],
  );

  // mpv has the value, or has said what it made of it.
  useEffect(() => {
    if (pending === null) return undefined;
    if (Math.abs(volume - pending) < 0.5) {
      setPending(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      setPending(null);
    }, SETTLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [pending, volume]);

  const shown = Math.round(Math.min(volumeMax, Math.max(0, pending ?? volume)));

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const asked = Number(e.target.value);
    if (!Number.isFinite(asked)) return;
    // The slider holds the value to its ends already; so does what mpv is asked for.
    const value = Math.min(volumeMax, Math.max(0, asked));
    setPending(value);
    sendVolume(value);
  };

  const toggleMute = () => {
    playerCommand({ type: 'setMute', muted: !muted }).catch(warn);
  };

  const label = t('player.volume');
  const style = {
    '--fill': shown / volumeMax,
    '--mark': FULL_VOLUME / volumeMax,
  } as CSSProperties;

  return (
    <div className={styles.volume}>
      <ControlButton
        label={t('player.mute')}
        icon={muted ? MUTED : VOLUME}
        aria-pressed={muted}
        onClick={toggleMute}
      />
      <div className={styles.slider} style={style}>
        <input
          type="range"
          className={styles.input}
          min={0}
          max={volumeMax}
          step={1}
          value={shown}
          aria-label={label}
          aria-valuetext={t('player.volumeValue', { percent: shown })}
          onChange={onChange}
          {...blurAfterPointer}
        />
        {volumeMax > FULL_VOLUME && <span className={styles.mark} aria-hidden />}
      </div>
    </div>
  );
}
