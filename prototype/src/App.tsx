import { useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Controls } from './components/Controls';
import { StartScreen } from './components/StartScreen';
import { TitleBar } from './components/TitleBar';
import { createFullscreenController, nextFrame } from './fullscreen';
import { useGlassRegions } from './glass/useGlassRegions';
import { installKeyboardForwarding, videoPointerHandlers } from './input/forward';
import { badgeFor } from './playerState';
import { useIdle } from './useIdle';
import { usePlayer } from './usePlayer';

export function App() {
  const s = usePlayer();
  const [curtain, setCurtain] = useState(false);
  const [glassOn, setGlassOn] = useState(true);
  const resizeWaiters = useRef<Array<() => void>>([]);
  const idle = useIdle(2500) && s.loaded && !s.pause;

  useGlassRegions(s.loaded && glassOn);
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

  return (
    <div className={`app${s.loaded ? '' : ' idle-bg'}${idle ? ' idle' : ''}`}>
      {s.loaded && <div className="video-catcher" {...pointer} />}
      {!s.loaded && <StartScreen />}
      <TitleBar title={s.title || 'Kaleido M0'} badge={badgeFor(s)} hidden={idle} />
      {s.loaded && <Controls s={s} hidden={idle} />}
      <div className={curtain ? 'curtain on' : 'curtain'} />
    </div>
  );
}
