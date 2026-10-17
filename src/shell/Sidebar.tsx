/**
 * The sidebar (spec 8.3): the pages of M1, Player and Settings (plan decision 3).
 *
 * - Without video (the start screen, the settings) it is docked: always shown beside the page.
 * - Over the video it is hidden until ☰ or the pointer at the window's left edge (`EDGE_PX`)
 *   opens it. Esc closes it (and does not go on to mpv, where it would leave fullscreen), as does
 *   a click beside it (which does not reach the video either) or choosing a page. Opened at the
 *   edge, it only peeks: it closes again once the pointer has moved on past it.
 * - The arrows (and Home, End) move between the items; the current page is the one Tab reaches.
 *   Opened with the keyboard, the focus goes into it, and back to ☰ when it closes.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useGlassRegion } from '../glass/useGlassRegion';
import { blurAfterPointer } from '../input/forward';
import { useUiStore, type Page } from '../state/uiStore';
import glass from '../theme/glass.module.css';
import { readZoomFrame, toWindowBox } from '../theme/zoom';
import Icon, { PLAYER, SETTINGS } from './Icon';
import styles from './Sidebar.module.css';

/** Docked beside a page, or over the video. */
export type SidebarMode = 'docked' | 'overlay';

/**
 * How the sidebar over the video was opened: with the keyboard the focus goes into it; with the
 * pointer at the edge it only peeks.
 */
export type SidebarOpener = 'pointer' | 'keyboard' | 'edge';

/** The pointer this close to the window's left edge (CSS px of the window) opens the sidebar over the video. */
export const EDGE_PX = 8;

/** A sidebar that peeks closes once the pointer is this far to the right of it. */
const PEEK_MARGIN_PX = 24;

const ITEMS: readonly { page: Page; label: string; icon: string }[] = [
  { page: 'player', label: 'shell.sidebar.player', icon: PLAYER },
  { page: 'settings', label: 'shell.sidebar.settings', icon: SETTINGS },
];

/** The item the key moves to from `index`, or -1 for a key that moves nothing. */
function moveTo(key: string, index: number): number {
  const last = ITEMS.length - 1;
  if (key === 'ArrowDown') return index === last ? 0 : index + 1;
  if (key === 'ArrowUp') return index === 0 ? last : index - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  return -1;
}

export interface SidebarProps {
  id: string;
  mode: SidebarMode;
  /** How it was last opened (over the video). */
  openedBy: SidebarOpener;
  /** The pointer reached the left edge while it was closed over the video. */
  onOpenAtEdge: () => void;
  /** It closed with the focus inside: the focus goes back to ☰. */
  onReturnFocus: () => void;
}

export default function Sidebar({ id, mode, openedBy, onOpenAtEdge, onReturnFocus }: SidebarProps) {
  const { t } = useTranslation();
  const page = useUiStore((state) => state.page);
  const setPage = useUiStore((state) => state.setPage);
  const open = useUiStore((state) => state.sidebarOpen);
  const setOpen = useUiStore((state) => state.setSidebarOpen);
  const panel = useRef<HTMLElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const overlay = mode === 'overlay';
  const shown = !overlay || open;
  // Over the page there is no video to blur.
  useGlassRegion(panel, undefined, overlay);

  const close = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  // The pointer at the left edge opens it over the video; opened that way, it closes again once
  // the pointer has moved on past it (unless the keyboard went in meanwhile).
  useEffect(() => {
    if (!overlay) return undefined;
    const onMove = (e: globalThis.PointerEvent) => {
      if (!open) {
        if (e.clientX <= EDGE_PX) onOpenAtEdge();
        return;
      }
      const element = panel.current;
      if (openedBy !== 'edge' || !element || element.contains(document.activeElement)) return;
      const box = toWindowBox(element.getBoundingClientRect(), readZoomFrame());
      if (e.clientX > box.left + box.width + PEEK_MARGIN_PX) close();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
    };
  }, [overlay, open, openedBy, onOpenAtEdge, close]);

  // Esc closes it over the video, wherever the focus is. This listener runs before the one that
  // sends keys to mpv (on window), which leaves a key alone once it is handled.
  useEffect(() => {
    if (!overlay || !open) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [overlay, open, close]);

  // Opened with the keyboard: the focus goes to the current page.
  useEffect(() => {
    if (overlay && open && openedBy === 'keyboard') {
      items.current[ITEMS.findIndex((item) => item.page === page)]?.focus();
    }
  }, [overlay, open, openedBy, page]);

  // Hidden with the focus inside (Esc, choosing the player): the focus goes back to ☰ before the
  // hidden items lose it.
  const wasShown = useRef(shown);
  useLayoutEffect(() => {
    if (wasShown.current && !shown && panel.current?.contains(document.activeElement)) onReturnFocus();
    wasShown.current = shown;
  }, [shown, onReturnFocus]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const index = items.current.findIndex((item) => item !== null && item === document.activeElement);
    if (index < 0) return;
    const next = moveTo(e.key, index);
    if (next < 0) return;
    // Handled here: mpv does not get the arrow too.
    e.preventDefault();
    items.current[next]?.focus();
  };

  const choose = (target: Page) => {
    setPage(target);
    setOpen(false);
  };

  // A click beside the sidebar over the video closes it and goes no further.
  const onScrim = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    close();
  };

  const state = shown ? 'open' : 'closed';

  return (
    <>
      {overlay && open && <div className={styles.scrim} onPointerDown={onScrim} aria-hidden />}
      <nav
        ref={panel}
        id={id}
        className={`${glass.glass} ${styles.panel}`}
        aria-label={t('shell.sidebar.label')}
        data-mode={mode}
        data-state={state}
        inert={!shown}
        aria-hidden={shown ? undefined : true}
        onKeyDown={onKeyDown}
      >
        <div className={styles.brand}>
          <span className={styles.dot} aria-hidden />
          <span>{t('shell.appName')}</span>
        </div>
        <ul className={styles.list}>
          {ITEMS.map((item, index) => {
            const current = item.page === page;
            return (
              <li key={item.page}>
                <button
                  ref={(element) => {
                    items.current[index] = element;
                  }}
                  type="button"
                  className={styles.item}
                  aria-current={current ? 'page' : undefined}
                  tabIndex={current ? 0 : -1}
                  onClick={() => {
                    choose(item.page);
                  }}
                  {...blurAfterPointer}
                >
                  <Icon path={item.icon} />
                  <span>{t(item.label)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
