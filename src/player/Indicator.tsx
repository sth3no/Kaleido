/**
 * The indicator (spec 5.3): the glass capsule at the top in the middle that gives the feedback for
 * the volume, the speed and a seek. The default input.conf binds those keys with `no-osd` and
 * adds `script-message kaleido osd <volume|speed|seek>`, which arrives as `player:message` with
 * the args `["osd", "<what>"]` (Rust strips the leading `kaleido`, src-tauri/src/player/state.rs).
 * mpv's own OSD stays for plugins.
 *
 * The message only says what changed, not the value. mpv may deliver it before the property
 * change it refers to, so the capsule reads the value from the store while it is shown (the
 * readouts below select it themselves) and not once at message time. For the same reason the
 * readouts exist only while the capsule shows: a seek readout selects `time-pos`, which changes
 * ten times a second, and nothing may draw for it while the video plays (spec 13).
 *
 * It shows for one second after the last message, then fades. The capsule is a live region that is
 * always in the page (a region that appears with its text is announced unreliably); its text is a
 * label for screen readers (visually hidden) and the value, and it is polite: a volume that is
 * held down is not read out step by step over what the user is listening to. It is glass over the
 * video, so while it shows it is one of the regions the shader blurs. It joins the list when it
 * comes up and leaves it when it is gone, after the islands that are already there (the shader
 * keeps the first six, glass/useGlassRegion.ts); should all six be taken it shows without the
 * blur, still readable on its tint (at least 45 %) and its text shadow (spec 8.9).
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import { glassRegions, useGlassRegion } from '../glass/useGlassRegion';
import { formatNumber, formatTime } from '../i18n/format';
import { onMessage } from '../ipc/events';
import { listenTo } from '../ipc/listen';
import Icon, { CLOCK, FAST_FORWARD, MUTED, VOLUME } from '../shell/Icon';
import {
  selectDuration,
  selectSpeed,
  selectTimePos,
  selectVolume,
  usePlayerStore,
} from '../state/playerStore';
import glass from '../theme/glass.module.css';
import styles from './Indicator.module.css';
import { volumeMaxOf } from './VolumeControl';

/** How long the capsule shows after the last message, ms. */
export const INDICATOR_MS = 1000;
/** A little more than its fade (`--k-motion-base`, 200 ms), so that it has faded when the readout goes. */
export const INDICATOR_FADE_MS = 250;

export type OsdKind = 'volume' | 'speed' | 'seek';

function isOsdKind(value: string | undefined): value is OsdKind {
  return value === 'volume' || value === 'speed' || value === 'seek';
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** A thin bar for a share of something, `fill` from 0 to 1. */
function Bar({ fill }: { fill: number }) {
  return <span className={styles.bar} style={{ '--fill': fill } as CSSProperties} aria-hidden />;
}

function VolumeReadout() {
  const { t } = useTranslation();
  const volume = usePlayerStore((state) => selectVolume(state.props));
  const volumeMax = usePlayerStore((state) => volumeMaxOf(state.props['volume-max']));
  const muted = usePlayerStore((state) => state.props['mute'] === true);
  return (
    <>
      <Icon path={muted ? MUTED : VOLUME} />
      <span className={styles.label}>{t('player.volume')}</span>
      <span className={`${styles.value} tabular`}>
        {muted ? t('player.muted') : t('player.volumeValue', { percent: formatNumber(Math.round(volume)) })}
      </span>
      <Bar fill={muted ? 0 : clamp01(volume / volumeMax)} />
    </>
  );
}

function SpeedReadout() {
  const { t } = useTranslation();
  const speed = usePlayerStore((state) => selectSpeed(state.props));
  return (
    <>
      <Icon path={FAST_FORWARD} />
      <span className={styles.label}>{t('player.speed')}</span>
      <span className={`${styles.value} tabular`}>
        {t('player.speedValue', { speed: formatNumber(speed, { maximumFractionDigits: 2 }) })}
      </span>
    </>
  );
}

function SeekReadout() {
  const { t } = useTranslation();
  const time = usePlayerStore((state) => selectTimePos(state.props));
  const duration = usePlayerStore((state) => selectDuration(state.props));
  // A film of an hour or more: both times are written with the hours (as the seekbar does).
  const long = duration >= 3600;
  const position = formatTime(time, long);
  // A stream may not know its length yet: the place alone.
  const text =
    duration > 0 ? t('player.seek.value', { position, duration: formatTime(duration, long) }) : position;
  return (
    <>
      <Icon path={CLOCK} />
      <span className={styles.label}>{t('player.seek.label')}</span>
      <span className={`${styles.value} tabular`}>{text}</span>
      {duration > 0 && <Bar fill={clamp01(time / duration)} />}
    </>
  );
}

function Readout({ kind }: { kind: OsdKind }) {
  switch (kind) {
    case 'volume':
      return <VolumeReadout />;
    case 'speed':
      return <SpeedReadout />;
    case 'seek':
      return <SeekReadout />;
  }
}

/** What the capsule is about. `seq` counts the messages, so that each one starts the second anew. */
interface Osd {
  kind: OsdKind;
  /** Visible; false while it fades. */
  shown: boolean;
  seq: number;
}

export default function Indicator() {
  const [osd, setOsd] = useState<Osd | null>(null);
  const loaded = usePlayerStore((state) => state.loaded);
  const capsule = useRef<HTMLDivElement>(null);
  // Blurred by the shader while it is up over a video. Before a file is loaded the page is opaque.
  useGlassRegion(capsule, undefined, osd !== null && loaded);

  useEffect(
    () =>
      listenTo(
        onMessage,
        ({ args }) => {
          const [action, kind] = args;
          if (action !== 'osd' || !isOsdKind(kind)) return;
          setOsd((previous) => ({ kind, shown: true, seq: (previous?.seq ?? 0) + 1 }));
        },
        'player:message',
      ),
    [],
  );

  // A second after the last message it fades, and when it has faded the readout is taken away.
  const seq = osd?.seq;
  useEffect(() => {
    if (seq === undefined) return undefined;
    const fade = setTimeout(() => {
      setOsd((current) => (current ? { ...current, shown: false } : current));
    }, INDICATOR_MS);
    const remove = setTimeout(() => {
      setOsd(null);
    }, INDICATOR_MS + INDICATOR_FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(remove);
    };
  }, [seq]);

  return (
    <div
      ref={capsule}
      className={`${glass.glass} ${styles.capsule}`}
      role="status"
      aria-live="polite"
      aria-atomic
      data-shown={osd?.shown === true}
      // The glass joins the list as the capsule starts to fade in; where it ended up is measured
      // when the fade is over (glass/useGlassRegion.ts sees only transitions that start after it).
      onTransitionEnd={() => {
        glassRegions.schedule();
      }}
    >
      {osd && <Readout kind={osd.kind} />}
    </div>
  );
}
