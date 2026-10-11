import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { playerCommand } from '../player';
import { formatTime } from '../playerState';

type Hover = { x: number; t: number };

/** Seekbar with a thumbfast preview rendered by React inside a glass bubble (spec 8.4). */
export function Seekbar({ timePos, duration }: { timePos: number; duration: number }) {
  const bar = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const lastRequested = useRef(-1);
  const [hover, setHover] = useState<Hover | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const unlisten = listen<{ width: number; height: number }>('thumb:ready', async (e) => {
      const { width, height } = e.payload;
      const buffer = await invoke<ArrayBuffer>('thumb_fetch');
      const target = canvas.current;
      if (!target || buffer.byteLength !== width * height * 4) return;
      target.width = width;
      target.height = height;
      target.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0);
      setSize({ w: width / window.devicePixelRatio, h: height / window.devicePixelRatio });
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const at = (clientX: number): Hover => {
    const box = bar.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    return { x: clientX - box.left, t: f * duration };
  };

  return (
    <div
      className="seekbar"
      ref={bar}
      onPointerMove={(e) => {
        const h = at(e.clientX);
        setHover(h);
        if (duration > 0 && Math.abs(h.t - lastRequested.current) >= 0.25) {
          lastRequested.current = h.t;
          invoke('thumb_request', { seconds: h.t }).catch(() => undefined);
        }
      }}
      onPointerLeave={() => {
        setHover(null);
        lastRequested.current = -1;
        invoke('thumb_clear').catch(() => undefined);
      }}
      onPointerDown={(e) => {
        if (duration > 0) void playerCommand({ type: 'seekAbsolute', seconds: at(e.clientX).t });
      }}
    >
      <div className="seek-track">
        <div className="seek-fill" style={{ width: `${duration ? (timePos / duration) * 100 : 0}%` }} />
      </div>
      <div className={hover ? 'thumb glass' : 'thumb glass off'} data-glass style={{ left: hover?.x ?? 0 }}>
        <canvas ref={canvas} style={size ? { width: size.w, height: size.h } : { display: 'none' }} />
        <span className="time">{formatTime(hover?.t ?? 0)}</span>
      </div>
    </div>
  );
}
