/**
 * The capsule at the top right (spec 8.4): minimise, maximise/restore and close, through Tauri's
 * window API. Closing asks Rust (`CloseRequested`), which lets mpv save the position first. Over the
 * video the buttons sit on glass; on a page (no video) they stand on it plainly, as in the mockups.
 *
 * The maximise button is also measured for Windows (`useCaptionButton`): Windows hit-tests it
 * itself, so that resting the pointer on it opens Snap Layouts (src-tauri/src/surface/caption.rs).
 */

import { getCurrentWindow, type Window as AppWindow } from '@tauri-apps/api/window';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useGlassRegion } from '../glass/useGlassRegion';
import { blurAfterPointer } from '../input/forward';
import { listenTo } from '../ipc/listen';
import { usePlayerStore } from '../state/playerStore';
import glass from '../theme/glass.module.css';
import { SNAP_LAYOUTS, useCaptionButton } from './captionButtons';
import Icon, { CLOSE, MAXIMIZE, MINIMIZE, RESTORE } from './Icon';
import styles from './WindowIsland.module.css';

/** An action on the app's window; a failure is only logged (the window is going away, say). */
function windowAction(what: string, action: (window: AppWindow) => Promise<void>): () => void {
  return () => {
    action(getCurrentWindow()).catch((error: unknown) => {
      console.warn(what, error);
    });
  };
}

const minimize = windowAction('minimize', (window) => window.minimize());
const toggleMaximize = windowAction('toggleMaximize', (window) => window.toggleMaximize());
const close = windowAction('close', (window) => window.close());

/** Whether the window is maximised: asked at once and again after every resize (maximise, restore, snap). */
function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const current = getCurrentWindow();
    let mounted = true;
    const read = () => {
      current.isMaximized().then(
        (now) => {
          if (mounted) setMaximized(now);
        },
        (error: unknown) => {
          console.warn('isMaximized', error);
        },
      );
    };
    read();
    const stop = listenTo<undefined>(
      (callback) =>
        current.onResized(() => {
          callback(undefined);
        }),
      read,
      'the window size',
    );
    return () => {
      mounted = false;
      stop();
    };
  }, []);
  return maximized;
}

export interface WindowIslandProps {
  /** Over the video: on glass. On a page: plain. */
  overVideo: boolean;
}

export default function WindowIsland({ overVideo }: WindowIslandProps) {
  const { t } = useTranslation();
  const island = useRef<HTMLDivElement>(null);
  const maximizeButton = useRef<HTMLButtonElement>(null);
  const maximized = useMaximized();
  // A fullscreen window has nothing to maximise or restore: the button is off, and Windows is not
  // told about it.
  const fullscreen = usePlayerStore((state) => state.props['fullscreen'] === true);
  useGlassRegion(island, undefined, overVideo);
  useCaptionButton(maximizeButton, !fullscreen);

  const look = overVideo ? `${glass.glass} ${styles.island}` : `${styles.island} ${styles.plain}`;
  const className = SNAP_LAYOUTS ? `${look} ${styles.caption}` : look;
  const maximizeLabel = maximized ? t('shell.window.restore') : t('shell.window.maximize');

  return (
    <div ref={island} className={className} data-tauri-drag-region data-island>
      <button
        type="button"
        className={styles.button}
        aria-label={t('shell.window.minimize')}
        title={t('shell.window.minimize')}
        onClick={minimize}
        {...blurAfterPointer}
      >
        <Icon path={MINIMIZE} />
      </button>
      <button
        ref={maximizeButton}
        type="button"
        className={styles.button}
        aria-label={maximizeLabel}
        title={maximizeLabel}
        disabled={fullscreen}
        onClick={toggleMaximize}
        {...blurAfterPointer}
      >
        <Icon path={maximized ? RESTORE : MAXIMIZE} />
      </button>
      <button
        type="button"
        className={`${styles.button} ${styles.close}`}
        aria-label={t('shell.window.close')}
        title={t('shell.window.close')}
        onClick={close}
        {...blurAfterPointer}
      >
        <Icon path={CLOSE} />
      </button>
    </div>
  );
}
