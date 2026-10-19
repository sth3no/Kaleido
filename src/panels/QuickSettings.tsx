/**
 * Quick settings (spec 8.5, point 2): the panel over the Subtitles button with two tabs, and a
 * third for a link.
 *
 * - Subtitles: the tracks of the file with "Off" at the end, "Load from file…" (the open dialog for
 *   a subtitle file; Rust adds it to the playing file and selects it), the size (`sub-scale`, 50 to
 *   200 %) and the delay in steps of 0.1 s.
 * - Audio: the audio tracks, and the delay in steps of 0.05 s.
 * - Quality (`QualityTab`): only while a link plays (an http(s) `path`). When what plays stops being
 *   a link while that tab is open, the panel goes to Subtitles.
 *
 * The tab is `uiStore.quickTab`: the Subtitles button opens the panel on the first tab, the Quality
 * button on the last. What the panels set goes to mpv as commands, and what they show is mpv's own
 * report (`sid`, `aid`, `sub-scale`, `sub-delay`, `audio-delay`) with the value the user just set
 * standing in until mpv has reported it (`useSettled`).
 *
 * The tabs are a tablist: the arrows (and Home, End) move between them and switch, and say so with
 * `preventDefault` so that mpv does not also get the key.
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

import { formatNumber } from '../i18n/format';
import { systemOpenDialog } from '../ipc/commands';
import { throttle } from '../player/throttle';
import Icon, { PLUS } from '../shell/Icon';
import { selectTracks, usePlayerStore } from '../state/playerStore';
import { useUiStore, type QuickTab } from '../state/uiStore';
import { selectStreamUrl } from '../streams/streamStore';
import DelayStepper from './DelayStepper';
import styles from './Panel.module.css';
import Popover from './Popover';
import { numberProp, selectedTrackId, sendCommand } from './props';
import QualityTab from './QualityTab';
import quick from './QuickSettings.module.css';
import TrackList from './TrackList';
import { useSettled } from './useSettled';

/** The size of the subtitles (`sub-scale`, 1 is as the file or the font has it) the panel offers. */
export const SUB_SCALE = { min: 0.5, max: 2, step: 0.05 } as const;

/** One press of the subtitle delay's buttons, seconds. */
export const SUB_DELAY_STEP_S = 0.1;

/** One press of the audio delay's buttons, seconds. */
export const AUDIO_DELAY_STEP_S = 0.05;

/** The size goes to mpv at most this often while the slider moves, ms. */
export const SCALE_THROTTLE_MS = 30;

/** A subtitle size held to 50 to 200 % and to hundredths (the slider's 0.05 steps add up). */
export function clampSubScale(scale: number): number {
  return Math.min(SUB_SCALE.max, Math.max(SUB_SCALE.min, Math.round(scale * 100) / 100));
}

/** The tabs of a file, and of a link, which can also be set to another quality. */
const FILE_TABS: readonly QuickTab[] = ['subtitles', 'audio'];
const STREAM_TABS: readonly QuickTab[] = ['subtitles', 'audio', 'quality'];

const warn = (what: string) => (error: unknown) => {
  console.warn(what, error);
};

function SubtitleSize() {
  const { t } = useTranslation();
  const id = useId();
  const reported = usePlayerStore((state) => numberProp(state.props, 'sub-scale', 1));
  const [shown, setShown] = useSettled(reported);

  const send = useMemo(
    () =>
      throttle((scale: number) => {
        sendCommand({ type: 'setSubScale', scale });
      }, SCALE_THROTTLE_MS),
    [],
  );
  // The panel closes (Esc, a press outside) a moment after the last move of the slider: what was
  // held back goes now, or the size the user saw would not be the one mpv has.
  useEffect(
    () => () => {
      send.flush();
    },
    [send],
  );

  const value = clampSubScale(shown);
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const asked = Number(e.target.value);
    if (!Number.isFinite(asked)) return;
    const scale = clampSubScale(asked);
    setShown(scale);
    send(scale);
  };

  const percent = formatNumber(value, { style: 'percent', maximumFractionDigits: 0 });
  const fill = (value - SUB_SCALE.min) / (SUB_SCALE.max - SUB_SCALE.min);
  return (
    <div className={styles.row}>
      <label htmlFor={id} className={styles.label}>
        {t('panels.subtitles.size')}
      </label>
      <input
        id={id}
        type="range"
        className={styles.range}
        style={{ '--fill': fill } as CSSProperties}
        min={SUB_SCALE.min}
        max={SUB_SCALE.max}
        step={SUB_SCALE.step}
        value={value}
        aria-valuetext={percent}
        onChange={onChange}
      />
      {/* Not a live region (an output is one): the slider's aria-valuetext says the value. */}
      <output htmlFor={id} className={`${styles.value} tabular`} aria-live="off">
        {percent}
      </output>
    </div>
  );
}

function SubtitlesTab() {
  const { t } = useTranslation();
  const tracks = usePlayerStore((state) => selectTracks('sub')(state.props));
  const selected = usePlayerStore((state) => selectedTrackId(state.props, 'sub'));
  const delay = usePlayerStore((state) => numberProp(state.props, 'sub-delay', 0));

  // The commands are here and not in the markup, which has no text of its own to write.
  const select = (id: number | null) => {
    sendCommand({ type: 'selectTrack', kind: 'sub', id });
  };
  const setDelay = (seconds: number) => {
    sendCommand({ type: 'setSubDelay', seconds });
  };
  const load = () => {
    systemOpenDialog('subtitle').catch(warn('system_open_dialog'));
  };

  return (
    <>
      {tracks.length > 0 ? (
        <TrackList
          label={t('panels.subtitles.tracks')}
          tracks={tracks}
          selected={selected}
          offLabel={t('panels.subtitles.off')}
          onSelect={select}
        />
      ) : (
        <p className={styles.empty}>{t('panels.subtitles.none')}</p>
      )}
      <button
        type="button"
        className={`${styles.option} ${styles.action}`}
        onClick={load}
      >
        <Icon path={PLUS} />
        <span className={styles.name}>{t('panels.subtitles.load')}</span>
      </button>
      <div className={styles.separator} role="separator" />
      <SubtitleSize />
      <DelayStepper
        label={t('panels.delay.label')}
        value={delay}
        step={SUB_DELAY_STEP_S}
        onChange={setDelay}
      />
    </>
  );
}

function AudioTab() {
  const { t } = useTranslation();
  const tracks = usePlayerStore((state) => selectTracks('audio')(state.props));
  const selected = usePlayerStore((state) => selectedTrackId(state.props, 'audio'));
  const delay = usePlayerStore((state) => numberProp(state.props, 'audio-delay', 0));

  const select = (id: number | null) => {
    sendCommand({ type: 'selectTrack', kind: 'audio', id });
  };
  const setDelay = (seconds: number) => {
    sendCommand({ type: 'setAudioDelay', seconds });
  };

  return (
    <>
      {tracks.length > 0 ? (
        <TrackList
          label={t('panels.audio.tracks')}
          tracks={tracks}
          selected={selected}
          onSelect={select}
        />
      ) : (
        <p className={styles.empty}>{t('panels.audio.none')}</p>
      )}
      <div className={styles.separator} role="separator" />
      <DelayStepper
        label={t('panels.delay.label')}
        value={delay}
        step={AUDIO_DELAY_STEP_S}
        onChange={setDelay}
      />
    </>
  );
}

export interface QuickSettingsProps {
  /** The button that opened the panel. */
  anchor: RefObject<HTMLElement | null>;
}

export default function QuickSettings({ anchor }: QuickSettingsProps) {
  const { t } = useTranslation();
  const stored = useUiStore((state) => state.quickTab);
  const setQuickTab = useUiStore((state) => state.setQuickTab);
  const setPanel = useUiStore((state) => state.setPanel);
  const stream = usePlayerStore((state) => selectStreamUrl(state.props) !== null);
  const ids = useId();
  const tabs = useRef<Partial<Record<QuickTab, HTMLButtonElement | null>>>({});

  const names = stream ? STREAM_TABS : FILE_TABS;
  // What plays is no link (any more): there is no Quality tab to show, and the panel is on the first.
  const tab: QuickTab = names.includes(stored) ? stored : 'subtitles';
  useEffect(() => {
    if (tab !== stored) setQuickTab(tab);
  }, [tab, stored, setQuickTab]);

  const onTabKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const index = names.indexOf(tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % names.length;
    else if (e.key === 'ArrowLeft') next = (index + names.length - 1) % names.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = names.length - 1;
    const target = names[next];
    if (!target) return;
    // Handled here: mpv does not get the arrow too.
    e.preventDefault();
    setQuickTab(target);
    tabs.current[target]?.focus();
  };

  return (
    <Popover
      anchor={anchor}
      label={t('panels.quickSettings')}
      onClose={() => {
        setPanel(null);
      }}
      className={quick.quick}
    >
      <div role="tablist" aria-label={t('panels.tabs.label')} className={quick.tabs} onKeyDown={onTabKeyDown}>
        {names.map((name) => {
          const selected = name === tab;
          return (
            <button
              key={name}
              ref={(element) => {
                tabs.current[name] = element;
              }}
              type="button"
              role="tab"
              id={`${ids}-tab-${name}`}
              className={quick.tab}
              aria-selected={selected}
              aria-controls={`${ids}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                setQuickTab(name);
              }}
            >
              {t(`panels.tabs.${name}`)}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${ids}-panel`}
        aria-labelledby={`${ids}-tab-${tab}`}
        className={quick.section}
      >
        {tab === 'subtitles' && <SubtitlesTab />}
        {tab === 'audio' && <AudioTab />}
        {tab === 'quality' && <QualityTab />}
      </div>
    </Popover>
  );
}
