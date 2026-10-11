import { useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Controls } from './components/Controls';
import { MiniPlayer } from './components/MiniPlayer';
import { StartScreen } from './components/StartScreen';
import { TitleBar } from './components/TitleBar';
import { createFullscreenController, nextFrame } from './fullscreen';
import { useGlassRegions } from './glass/useGlassRegions';
import { installKeyboardForwarding, videoPointerHandlers } from './input/forward';
import { playerCommand, setSurfaceLayout } from './player';
import { badgeFor } from './playerState';
import { animateRect, miniRect, type Rect } from './surface/mini';
import { useIdle } from './useIdle';
import { usePlayer } from './usePlayer';

const fullRect = (): Rect => ({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });

export function App() {
  const s = usePlayer();
  const [curtain, setCurtain] = useState(false);
  const [glassOn, setGlassOn] = useState(true);
  const [mini, setMini] = useState<Rect | null>(null);
  const resizeWaiters = useRef<Array<() => void>>([]);
  const idle = useIdle(2500) && s.loaded && !s.pause && !mini;

  useGlassRegions(s.loaded && glassOn && !mini);
  useEffect(() => installKeyboardForwarding(), []);

  // `g` toggles the glass for A/B comparison. Capture phase + preventDefault means the
  // forwarding listener (bubble phase, checks defaultPrevented) never sends it to mpv.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'g' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setGlassOn((on) => !on);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, []);

  useEffect(() => {
    resizeWaiters.current.splice(0).forEach((resolve) => resolve());
  }, [s.osd.w, s.osd.h]);

  const applyFullscreen = useMemo(
    () =>
      createFullscreenController({
        setCurtain,
        nextFrame,
        setWindowFullscreen: (on) => getCurrentWindow().setFullscreen(on),
        waitForResize: (ms) =>
          new Promise<void>((resolve) => {
            resizeWaiters.current.push(resolve);
            setTimeout(resolve, ms);
          }),
      }),
    [],
  );

  useEffect(() => {
    void applyFullscreen(s.fullscreen);
  }, [s.fullscreen, applyFullscreen]);

  const pointer = useMemo(
    () => videoPointerHandlers(() => ({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight })),
    [],
  );

  // The UI frame and the native surface take the same rectangle every frame (spec 8.6).
  const follow = (r: Rect) => {
    setMini(r);
    void setSurfaceLayout({ kind: 'rect', ...r });
  };
  async function toMini() {
    await animateRect(fullRect(), miniRect(window.innerWidth, window.innerHeight), 220, follow);
  }
  async function toFull() {
    if (!mini) return;
    await animateRect(mini, fullRect(), 220, follow);
    setMini(null);
    await setSurfaceLayout({ kind: 'full' });
  }

  return (
    <div className={`app${s.loaded ? '' : ' idle-bg'}${idle ? ' idle' : ''}`}>
      {s.loaded && !mini && <div className="video-catcher" {...pointer} />}
      {!s.loaded && <StartScreen />}
      <TitleBar title={s.title || 'Kaleido M0'} badge={badgeFor(s)} hidden={idle} />
      {s.loaded && !mini && <Controls s={s} hidden={idle} onMini={toMini} />}
      {mini && (
        <>
          <div className="page">Stránka (simulace Obchodu)</div>
          <MiniPlayer
            rect={mini}
            pause={s.pause}
            onTogglePause={() => playerCommand({ type: 'togglePause' })}
            onExpand={toFull}
          />
        </>
      )}
      <div className={curtain ? 'curtain on' : 'curtain'} />
    </div>
  );
}
