/**
 * The app's window (spec 8.3, 8.4). From the bottom up:
 *
 * 1. `VideoLayer`: transparent, where mpv's window is; it passes input to mpv. While mpv's window
 *    is the mini player (or on its way there) the pointer stays in the UI (Ruling R45).
 *    Above it the mini player's hole (`MiniHole`): the page's background around the video.
 * 2. The page: the start screen (`home`), the player (`player`) or the settings (`settings`), as
 *    the tasks that build them pass them in. Over the video the page layer lets the pointer
 *    through to the video: the player page gives its controls `pointer-events: auto`. A page
 *    paints no background of its own: the root does, or the mini player's hole around the video.
 *    Above it the mini player's frame and controls (`MiniPlayer`), while a file is open and
 *    another page is shown (`surface/useSurfaceLayout.ts` moves mpv's window there).
 * 3. On a page (no video): a strip along the top that moves the window, as a title bar would.
 *    The top `--shell-titlebar-height` of a docked page is that strip's: no controls there.
 * 4. The islands: the title capsule (over the video only) and the window buttons. They fade with
 *    the player's own islands when the video has played 2.5 s without movement
 *    (`uiStore.controlsHidden`, set by `useAutohide`).
 * 5. The sidebar, docked beside the page or over the video.
 * 6. The notices (`notices`): the error cards, over everything.
 *
 * Which page: the settings while the user is there; the player while a file is loaded or loading
 * (mpv says it is not idle); else the start screen. It also starts the bridge to Rust, once for the
 * app, and makes the page transparent while a video is shown (spec 5.1: opaque until then): the
 * loaded player, and the mini player, whose hole layer paints the page around the video.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import MiniPlayer, { MiniHole, useMiniBox } from '../mini/MiniPlayer';
import { usePlayerBridge } from '../state/bridge';
import { usePlayerStore } from '../state/playerStore';
import { useUiStore } from '../state/uiStore';
import { useSurfaceLayout } from '../surface/useSurfaceLayout';
import styles from './AppShell.module.css';
import { SNAP_LAYOUTS } from './captionButtons';
import Sidebar, { type SidebarMode, type SidebarOpener } from './Sidebar';
import TitleIsland from './TitleIsland';
import { selectView } from './view';
import VideoLayer from './VideoLayer';
import WindowIsland from './WindowIsland';

export { selectView };
export type { View } from './view';

export interface AppShellProps {
  /** The start screen (Task 17). */
  home: ReactNode;
  /** The player page with its controls (Task 18). */
  player: ReactNode;
  /** The settings (Task 22). */
  settings: ReactNode;
  /**
   * The notices (the error cards, Task 19): over every view and above the sidebar, because a file
   * that fails to open leaves the player for the start screen at once, and the card is for that too.
   */
  notices?: ReactNode;
}

/**
 * While a video is shown, the page background (`--k-backdrop`, which html, body and the root
 * paint) is transparent, so that mpv's window under the WebView shows through.
 */
function useVideoBackdrop(on: boolean): void {
  // Before the paint: the page never shows its background over the video for a frame.
  useLayoutEffect(() => {
    if (!on) return undefined;
    const root = document.documentElement;
    root.setAttribute('data-video', 'true');
    return () => {
      root.removeAttribute('data-video');
    };
  }, [on]);
}

export default function AppShell({ home, player, settings, notices }: AppShellProps) {
  usePlayerBridge();
  const page = useUiStore((state) => state.page);
  const view = usePlayerStore((state) => selectView(page, state));
  const loaded = usePlayerStore((state) => state.loaded);
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const controlsHidden = useUiStore((state) => state.controlsHidden);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const [openedBy, setOpenedBy] = useState<SidebarOpener>('pointer');
  const sidebarId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);

  const overVideo = view === 'player';
  // Where mpv's window is: the whole window, or the mini player and the animation to it.
  const surface = useSurfaceLayout();
  const miniBox = useMiniBox(surface.rect);
  // The video is not the whole window, and there is room for it (else Rust shows none either).
  const miniPhase = surface.phase !== 'full' && miniBox !== null ? surface.phase : null;
  useVideoBackdrop((overVideo && loaded) || miniPhase !== null);
  // Open is a state of the sidebar over the video: a page shows it anyway, and the next video
  // starts with it closed.
  useEffect(() => {
    if (!overVideo) setSidebarOpen(false);
  }, [overVideo, setSidebarOpen]);

  const openSidebar = useCallback(
    (by: SidebarOpener) => {
      setOpenedBy(by);
      setSidebarOpen(true);
    },
    [setSidebarOpen],
  );
  const openAtEdge = useCallback(() => {
    openSidebar('edge');
  }, [openSidebar]);
  const onMenu = useCallback(
    (byKeyboard: boolean) => {
      if (useUiStore.getState().sidebarOpen) setSidebarOpen(false);
      else openSidebar(byKeyboard ? 'keyboard' : 'pointer');
    },
    [openSidebar, setSidebarOpen],
  );
  const returnFocus = useCallback(() => {
    menuButton.current?.focus();
  }, []);

  const mode: SidebarMode = overVideo ? 'overlay' : 'docked';
  const content = view === 'settings' ? settings : overVideo ? player : home;
  const dragStrip = SNAP_LAYOUTS ? `${styles.dragStrip} ${styles.caption}` : styles.dragStrip;

  return (
    <div className={styles.shell} data-view={view}>
      <VideoLayer pointer={surface.phase === 'full'} />
      {miniPhase && miniBox && <MiniHole box={miniBox} fade={surface.fade} />}
      <main className={styles.page} data-view={view}>
        {content}
      </main>
      {/* After the page: its controls come after the page's in the tab order. */}
      {miniPhase && miniBox && <MiniPlayer box={miniBox} phase={miniPhase} fade={surface.fade} />}
      {!overVideo && <div className={dragStrip} data-tauri-drag-region />}
      {/* Hidden, they are out of the tab order and of the screen reader's reach as well. */}
      <div className={styles.islands} data-hidden={controlsHidden} inert={controlsHidden}>
        {overVideo && (
          <TitleIsland
            menuRef={menuButton}
            sidebarId={sidebarId}
            sidebarOpen={sidebarOpen}
            onMenu={onMenu}
          />
        )}
        <WindowIsland overVideo={overVideo} />
      </div>
      <div className={styles.sidebar}>
        <Sidebar
          id={sidebarId}
          mode={mode}
          openedBy={openedBy}
          onOpenAtEdge={openAtEdge}
          onReturnFocus={returnFocus}
        />
      </div>
      <div className={styles.notices}>{notices}</div>
    </div>
  );
}
