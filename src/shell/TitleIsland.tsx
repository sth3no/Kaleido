/**
 * The capsule at the top left over the video (spec 8.4): ☰ for the sidebar, what is playing
 * (`media-title`, else the file name) and the resolution and HDR badge from `video-params`. The
 * window is moved by it: its background is the title bar (`data-tauri-drag-region`, and with the
 * Snap Layouts spike on, CSS `app-region` for WebView2's own caption; see captionButtons.ts).
 */

import { useRef, type MouseEvent, type Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { useGlassRegion } from '../glass/useGlassRegion';
import { blurAfterPointer } from '../input/forward';
import { selectTitle, selectVideoBadge, usePlayerStore } from '../state/playerStore';
import glass from '../theme/glass.module.css';
import { SNAP_LAYOUTS } from './captionButtons';
import Icon, { MENU } from './Icon';
import styles from './TitleIsland.module.css';

export interface TitleIslandProps {
  /** The ☰ button, which gets the focus back when the sidebar closes. */
  menuRef?: Ref<HTMLButtonElement>;
  /** The id of the sidebar ☰ opens. */
  sidebarId: string;
  sidebarOpen: boolean;
  /** ☰ was pressed; `byKeyboard` when Enter or Space did it (the focus then goes into the sidebar). */
  onMenu: (byKeyboard: boolean) => void;
}

export default function TitleIsland({ menuRef, sidebarId, sidebarOpen, onMenu }: TitleIslandProps) {
  const { t } = useTranslation();
  const title = usePlayerStore((state) => selectTitle(state.props));
  const badge = usePlayerStore((state) => selectVideoBadge(state.props));
  const island = useRef<HTMLDivElement>(null);
  useGlassRegion(island);

  // A click the keyboard made (Enter, Space) has no pointer behind it: detail 0.
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    onMenu(e.detail === 0);
  };

  const look = `${glass.glass} ${styles.island}`;
  const className = SNAP_LAYOUTS ? `${look} ${styles.caption}` : look;

  return (
    <div ref={island} className={className} data-tauri-drag-region>
      <button
        ref={menuRef}
        type="button"
        className={styles.menu}
        aria-label={t('shell.menu')}
        title={t('shell.menu')}
        aria-expanded={sidebarOpen}
        aria-controls={sidebarId}
        onClick={onClick}
        {...blurAfterPointer}
      >
        <Icon path={MENU} />
      </button>
      <span className={styles.dot} data-tauri-drag-region aria-hidden />
      <span className={styles.title} data-tauri-drag-region title={title}>
        {title}
      </span>
      {badge !== undefined && (
        <span className={styles.badge} data-tauri-drag-region>
          {badge}
        </span>
      )}
    </div>
  );
}
