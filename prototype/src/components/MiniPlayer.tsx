import { useMemo } from 'react';
import { blurAfterPointer, videoPointerHandlers } from '../input/forward';
import type { Rect } from '../surface/mini';

type Props = { rect: Rect; pause: boolean; onTogglePause(): void; onExpand(): void };

/** The hole in the opaque page where mpv's surface shows through (spec 8.3). */
export function MiniPlayer({ rect, pause, onTogglePause, onExpand }: Props) {
  const pointer = useMemo(
    () => videoPointerHandlers(() => ({ left: rect.x, top: rect.y, width: rect.w, height: rect.h })),
    [rect],
  );
  return (
    <div className="mini-frame" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <div className="mini-video-catcher" {...pointer} />
      <div className="mini-bar">
        <button className="icon-btn" aria-label={pause ? 'Přehrát' : 'Pozastavit'} onClick={onTogglePause} {...blurAfterPointer}>
          {pause ? '▶' : '❚❚'}
        </button>
        <button className="icon-btn" aria-label="Zpět na celé okno" onClick={onExpand} {...blurAfterPointer}>⤢</button>
      </div>
    </div>
  );
}
