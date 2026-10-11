import { useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Controls } from './components/Controls';
import { StartScreen } from './components/StartScreen';
import { TitleBar } from './components/TitleBar';
import { createFullscreenController, nextFrame } from './fullscreen';
import { installKeyboardForwarding, videoPointerHandlers } from './input/forward';
import { badgeFor } from './playerState';
import { usePlayer } from './usePlayer';

export function App() {
  const s = usePlayer();
  const [curtain, setCurtain] = useState(false);
  const resizeWaiters = useRef<Array<() => void>>([]);

  useEffect(() => installKeyboardForwarding(), []);

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
    <div className={s.loaded ? 'app' : 'app idle-bg'}>
      {s.loaded && <div className="video-catcher" {...pointer} />}
      {!s.loaded && <StartScreen />}
      <TitleBar title={s.title || 'Kaleido M0'} badge={badgeFor(s)} />
      {s.loaded && <Controls s={s} />}
      <div className={curtain ? 'curtain on' : 'curtain'} />
    </div>
  );
}
