/**
 * The mini player (spec 8.3; pages-navigation-v2.html, screen 2): while a file is open and another
 * page is shown, the video plays in the bottom-right corner of the opaque page. Where it is comes
 * from `surface/useSurfaceLayout.ts`, in CSS px of the window, the numbers Rust places mpv's
 * window by; `useMiniBox` turns them into the elements' own px under the UI scale, once, for
 * everything that is drawn on them:
 *
 * - The hole: the shell's page layer paints the page's background and is clipped by `holePath`
 *   (Ruling R46, shell/AppShell.tsx), so that nothing of the page draws over the video. Rust
 *   places mpv's window a pixel past it on every side (Ruling R47), so no seam shows.
 * - `MiniPlayer`, over the page: the frame (edge and shadow) and, once docked, the glass bar with
 *   play or pause, back to the player and stop. Its glass is one of the shader's regions: Rust
 *   moves it into mpv's window (Ruling R45). With the glass off it is opaque, as every glass is
 *   (theme/glass.module.css). While the video moves the frame takes no pointer: at the first and
 *   the last frame it is the whole window.
 * - `MiniCover`, with reduced motion: a cover over the video (or over the whole window, back in
 *   the player) that fades out, so that the video fades in instead of moving.
 *
 * The pointer over the video is the mini player's, not mpv's: the video layer under the page sends
 * mpv no pointer while the video is not the whole window (shell/VideoLayer.tsx). A double click
 * goes back to the player, and mpv never sees it, so it does not switch to fullscreen. A single
 * click does nothing: it would also come twice in every double click.
 *
 * With the keyboard, Stop leaves the focus on the page (its first control, else the sidebar's
 * current page) and Back to player on the player's play and pause button: the mini player and its
 * buttons go away, and the focus must not fall to nothing.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useGlassRegion } from '../glass/useGlassRegion';
import { sendCommand } from '../panels/props';
import ControlButton from '../player/ControlButton';
import { EXPAND, PAUSE, PLAY, STOP } from '../shell/Icon';
import { selectPaused, usePlayerStore } from '../state/playerStore';
import { useUiStore } from '../state/uiStore';
import type { Rect } from '../surface/mini';
import type { SurfacePhase } from '../surface/useSurfaceLayout';
import glass from '../theme/glass.module.css';
import { readZoomFrame, toOwnLength, type ZoomFrame } from '../theme/zoom';
import styles from './MiniPlayer.module.css';

/** The mini player's box in the elements' own CSS px (under the root's zoom), and its corner radius. */
export interface MiniBox {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

/** Hundredths of a px: nothing on the screen, and short numbers in the styles. */
const fine = (value: number): number => Math.round(value * 100) / 100;

/**
 * `rect` (CSS px of the window) in the own px of an element under the root's zoom, with the corner
 * radius `radius` (own px), at most half the shorter side.
 */
export function miniBox(rect: Rect, frame: ZoomFrame, radius: number): MiniBox {
  const own = (value: number) => fine(toOwnLength(value, frame));
  const w = own(rect.w);
  const h = own(rect.h);
  return { x: own(rect.x), y: own(rect.y), w, h, r: Math.max(0, Math.min(radius, w / 2, h / 2)) };
}

/**
 * The clip path of the page around the hole: everything (an area larger than any window), less the
 * rounded box. The even-odd rule leaves what is in both out. For an element that covers the window
 * from its top left corner (the shell's page layer).
 */
export function holePath({ x, y, w, h, r }: MiniBox): string {
  const all = 'M0 0H100000V100000H0Z';
  const [right, bottom] = [fine(x + w), fine(y + h)];
  const hole =
    r > 0
      ? `M${fine(x + r)} ${y}H${fine(right - r)}A${r} ${r} 0 0 1 ${right} ${fine(y + r)}` +
        `V${fine(bottom - r)}A${r} ${r} 0 0 1 ${fine(right - r)} ${bottom}` +
        `H${fine(x + r)}A${r} ${r} 0 0 1 ${x} ${fine(bottom - r)}` +
        `V${fine(y + r)}A${r} ${r} 0 0 1 ${fine(x + r)} ${y}Z`
      : `M${x} ${y}H${right}V${bottom}H${x}Z`;
  return `path(evenodd, '${all} ${hole}')`;
}

/** What the box depends on besides the rectangle: the UI scale and the glass' corner radius. */
interface Look {
  frame: ZoomFrame;
  radius: number;
}

function readLook(): Look {
  const root = document.documentElement;
  const radius = Number.parseFloat(getComputedStyle(root).getPropertyValue('--k-radius-l'));
  return { frame: readZoomFrame(root), radius: Number.isFinite(radius) && radius > 0 ? radius : 0 };
}

/**
 * The box for `rect` (`null` for none). Read again when the root's style changes (the UI scale and
 * the radius are variables on it, theme/useAppearance.ts); nothing runs otherwise.
 */
export function useMiniBox(rect: Rect | null): MiniBox | null {
  const [look, setLook] = useState(readLook);
  useEffect(() => {
    const root = new MutationObserver(() => {
      const next = readLook();
      setLook((current) =>
        current.frame.zoom === next.frame.zoom && current.radius === next.radius ? current : next,
      );
    });
    root.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => {
      root.disconnect();
    };
  }, []);
  return useMemo(() => (rect ? miniBox(rect, look.frame, look.radius) : null), [rect, look]);
}

const placed = ({ x, y, w, h, r }: MiniBox): CSSProperties => ({
  left: x,
  top: y,
  width: w,
  height: h,
  borderRadius: r,
});

export interface MiniCoverProps {
  /** Over the mini player; `null` for the whole window (back in the player). */
  box: MiniBox | null;
}

/**
 * The cover of reduced motion: the page's background (a plain colour under Mica, which it cannot
 * paint) over the video, fading out once. A new one for each fade (`key`).
 */
export function MiniCover({ box }: MiniCoverProps) {
  return (
    <div
      className={styles.cover}
      style={box ? placed(box) : { inset: 0 }}
      aria-hidden
      data-mini-cover={box ? 'mini' : 'full'}
    />
  );
}

export interface MiniPlayerProps {
  box: MiniBox;
  /** Not `full`: the shell shows the mini player only while the video is not the whole window. */
  phase: Exclude<SurfacePhase, 'full'>;
  /** The mini player came up without moving: the frame fades in. */
  fade: boolean;
}

/** The context menu of the WebView is not for the video. */
const noContextMenu = (e: MouseEvent) => {
  e.preventDefault();
};

/** What takes the focus first on a page. */
const FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Pressed with the keyboard: Enter and Space click with no click count. */
const byKeyboard = (e: MouseEvent) => e.detail === 0;

/** The page's first control, else the sidebar's item of the page that is shown. */
function focusThePage(): void {
  const first = document.querySelector('main')?.querySelector<HTMLElement>(FOCUSABLE);
  const current = document.querySelector<HTMLElement>('nav [aria-current="page"]');
  (first ?? current)?.focus();
}

/** The frame and the controls over the video (see the top of the file). */
export default function MiniPlayer({ box, phase, fade }: MiniPlayerProps) {
  const { t } = useTranslation();
  const bar = useRef<HTMLDivElement>(null);
  const paused = usePlayerStore((state) => selectPaused(state.props));
  // The controls come when the video has docked: in the animation they would have nothing to hold
  // on to, and their glass would trail behind.
  const docked = phase === 'mini';
  useGlassRegion(bar, undefined, docked);

  const togglePause = () => {
    sendCommand({ type: 'togglePause' });
  };
  const stop = (e: MouseEvent) => {
    sendCommand({ type: 'stop' });
    if (byKeyboard(e)) focusThePage();
  };
  const back = (e: MouseEvent) => {
    const ui = useUiStore.getState();
    if (byKeyboard(e)) ui.setFocusRequest('play');
    ui.setPage('player');
  };

  return (
    <section
      className={styles.frame}
      style={placed(box)}
      aria-label={t('player.mini.label')}
      data-mini-frame
      data-phase={phase}
      data-fade={fade}
      onContextMenu={noContextMenu}
    >
      <div className={styles.video} onDoubleClick={back} data-mini-video />
      {docked && (
        <div
          ref={bar}
          className={`${glass.glass} ${styles.bar}`}
          role="group"
          aria-label={t('player.controls')}
        >
          <ControlButton
            label={paused ? t('player.play') : t('player.pause')}
            icon={paused ? PLAY : PAUSE}
            onClick={togglePause}
          />
          <ControlButton label={t('player.mini.back')} icon={EXPAND} onClick={back} />
          <ControlButton label={t('player.mini.stop')} icon={STOP} onClick={stop} />
        </div>
      )}
    </section>
  );
}
