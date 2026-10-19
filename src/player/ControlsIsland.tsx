/**
 * The big island at the bottom (spec 8.4; key-screens-v2.html, screen 2): the timeline, and under
 * it the volume, previous / play and pause / next, and the buttons for the subtitles, the quality
 * (of a link only), the playlist and fullscreen, in that order (spec 8.4).
 *
 * - Previous and next work with a playlist; without one they are off.
 * - The subtitles button opens quick settings on its Subtitles tab, the quality button on its
 *   Quality tab, and the playlist button the playlist (`uiStore.panel` and `quickTab`). The quality
 *   button shows only while a link plays (an http(s) `path`) and says the quality that plays in a
 *   word (`1080p`, `Auto`). The panels are `panels/`: they stand over the button that opened them,
 *   which they get as their anchor, and are drawn by the island so that they go with it (when the
 *   island goes, the panel is closed, whatever took the island away). Choosing a quality reloads
 *   the link, which ends the entry that plays and drops this island with it (`PlayerPage`): the
 *   Quality tab closes the panel itself when Rust has taken the choice.
 * - Fullscreen is mpv's property: the button asks mpv, and Rust switches the window (the UI never
 *   does), so a double click on the video and the key do the same.
 * - It is glass over the video, so it is one of the regions the shader blurs, and the subtitles
 *   are lifted above it while it is shown (`useSubMargin`).
 * - `hidden` fades it out (the video plays and nothing moved, `useAutohide`); it is then out of the
 *   tab order and of the screen reader's reach, and takes no pointer.
 */

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useGlassRegion } from '../glass/useGlassRegion';
import PlaylistPanel from '../panels/PlaylistPanel';
import { sendCommand } from '../panels/props';
import QuickSettings from '../panels/QuickSettings';
import {
  selectPaused,
  selectPlaylist,
  usePlayerStore,
} from '../state/playerStore';
import { useUiStore, type Panel } from '../state/uiStore';
import { shortQualityLabel } from '../streams/quality';
import { selectStreamUrl, useStreamFormats } from '../streams/streamStore';
import {
  EXIT_FULLSCREEN,
  FULLSCREEN,
  NEXT,
  PAUSE,
  PLAY,
  PLAYLIST,
  PREVIOUS,
  SUBTITLES,
} from '../shell/Icon';
import glass from '../theme/glass.module.css';
import ControlButton from './ControlButton';
import styles from './ControlsIsland.module.css';
import Seekbar from './Seekbar';
import { useSubMargin } from './subMargin';
import VolumeControl from './VolumeControl';

export interface ControlsIslandProps {
  /** Faded out: nothing moved for 2.5 s while the video plays. */
  hidden?: boolean;
}

/** The context menu of the WebView is not for the controls. */
const noContextMenu = (e: MouseEvent) => {
  e.preventDefault();
};

export default function ControlsIsland({ hidden = false }: ControlsIslandProps) {
  const { t } = useTranslation();
  const island = useRef<HTMLDivElement>(null);
  const subtitlesButton = useRef<HTMLButtonElement>(null);
  const qualityButton = useRef<HTMLButtonElement>(null);
  const playlistButton = useRef<HTMLButtonElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const focusRequest = useUiStore((state) => state.focusRequest);
  const paused = usePlayerStore((state) => selectPaused(state.props));
  // One entry is no list to go through.
  const hasPlaylist = usePlayerStore((state) => selectPlaylist(state.props).length > 1);
  const fullscreen = usePlayerStore((state) => state.props['fullscreen'] === true);
  const panel = useUiStore((state) => state.panel);
  const quickTab = useUiStore((state) => state.quickTab);
  const setPanel = useUiStore((state) => state.setPanel);
  const setQuickTab = useUiStore((state) => state.setQuickTab);
  const stream = usePlayerStore((state) => selectStreamUrl(state.props) !== null);
  const chosenQuality = useStreamFormats()?.chosen ?? null;
  // The button quick settings stands over: the one that opened it, as long as that button is there.
  const [opener, setOpener] = useState<'subtitles' | 'quality'>('subtitles');
  useGlassRegion(island);
  useSubMargin(island, hidden);

  // A panel belongs to the island: with the island gone it is closed. That is a decision, and it
  // covers `loaded` turning false (PlayerPage drops the island when the file ends or fails) as well
  // as another page: a panel is about the file that was playing, and an open panel with no island
  // would hold the next island open for good (the autohide stays off while `panel` is set).
  useEffect(
    () => () => {
      const { panel: open, setPanel: close } = useUiStore.getState();
      if (open !== null) close(null);
    },
    [],
  );

  // The keyboard came back from the mini player ("Back to player"): the focus goes on to play and
  // pause, not to the page. A hidden island is inert; it takes it when it shows.
  useEffect(() => {
    if (focusRequest !== 'play' || hidden) return;
    playButton.current?.focus();
    useUiStore.getState().setFocusRequest(null);
  }, [focusRequest, hidden]);

  const subtitlesOpen = panel === 'quick-settings' && quickTab === 'subtitles';
  const qualityOpen = panel === 'quick-settings' && quickTab === 'quality';
  const playlistOpen = panel === 'playlist';
  const quality = shortQualityLabel(chosenQuality, t);

  const toggleSubtitles = () => {
    if (subtitlesOpen) {
      setPanel(null);
      return;
    }
    setOpener('subtitles');
    setQuickTab('subtitles');
    setPanel('quick-settings');
  };
  const toggleQuality = () => {
    if (qualityOpen) {
      setPanel(null);
      return;
    }
    setOpener('quality');
    setQuickTab('quality');
    setPanel('quick-settings');
  };
  const togglePlaylist = () => {
    const open: Panel | null = playlistOpen ? null : 'playlist';
    setPanel(open);
  };
  // The commands are here and not in the markup, which has no text of its own to write.
  const previous = () => {
    sendCommand({ type: 'playlistPrev' });
  };
  const togglePause = () => {
    sendCommand({ type: 'togglePause' });
  };
  const next = () => {
    sendCommand({ type: 'playlistNext' });
  };
  const toggleFullscreen = () => {
    sendCommand({ type: 'setFullscreen', on: !fullscreen });
  };

  return (
    <div
      ref={island}
      className={`${glass.glass} ${styles.island}`}
      role="group"
      aria-label={t('player.controls')}
      data-island
      data-hidden={hidden}
      inert={hidden}
      onContextMenu={noContextMenu}
    >
      <Seekbar />
      <div className={styles.row}>
        <VolumeControl />
        <div className={styles.transport}>
          <ControlButton
            label={t('player.previous')}
            icon={PREVIOUS}
            disabled={!hasPlaylist}
            onClick={previous}
          />
          <ControlButton
            ref={playButton}
            label={paused ? t('player.play') : t('player.pause')}
            icon={paused ? PLAY : PAUSE}
            large
            onClick={togglePause}
          />
          <ControlButton
            label={t('player.next')}
            icon={NEXT}
            disabled={!hasPlaylist}
            onClick={next}
          />
        </div>
        <div className={styles.tools}>
          <ControlButton
            ref={subtitlesButton}
            label={t('player.subtitles')}
            icon={SUBTITLES}
            popup
            aria-expanded={subtitlesOpen}
            onClick={toggleSubtitles}
          />
          {stream && (
            <ControlButton
              ref={qualityButton}
              label={t('player.quality', { quality })}
              text={quality}
              popup
              aria-expanded={qualityOpen}
              onClick={toggleQuality}
            />
          )}
          <ControlButton
            ref={playlistButton}
            label={t('panels.playlist')}
            icon={PLAYLIST}
            popup
            aria-expanded={playlistOpen}
            onClick={togglePlaylist}
          />
          <ControlButton
            label={fullscreen ? t('player.exitFullscreen') : t('player.fullscreen')}
            icon={fullscreen ? EXIT_FULLSCREEN : FULLSCREEN}
            onClick={toggleFullscreen}
          />
        </div>
      </div>
      {panel === 'quick-settings' && (
        <QuickSettings anchor={opener === 'quality' && stream ? qualityButton : subtitlesButton} />
      )}
      {panel === 'playlist' && <PlaylistPanel anchor={playlistButton} />}
    </div>
  );
}
