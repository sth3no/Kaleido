import { blurAfterPointer } from '../input/forward';
import { playerCommand } from '../player';
import { formatTime, type PlayerState } from '../playerState';

export function Controls({ s, hidden = false }: { s: PlayerState; hidden?: boolean }) {
  return (
    <div className={`capsule glass controls${hidden ? ' hidden' : ''}`} data-glass>
      <div className="row">
        <span className="time">{formatTime(s.timePos)}</span>
        <input
          className="seek"
          type="range"
          min={0}
          max={s.duration || 0}
          step={0.1}
          value={Math.min(s.timePos, s.duration || 0)}
          aria-label="Pozice"
          onChange={(e) => playerCommand({ type: 'seekAbsolute', seconds: Number(e.target.value) })}
          {...blurAfterPointer}
        />
        <span className="time">{formatTime(s.duration)}</span>
      </div>
      <div className="row">
        <input
          className="volume"
          type="range"
          min={0}
          max={130}
          value={s.volume}
          aria-label="Hlasitost"
          onChange={(e) => playerCommand({ type: 'setVolume', value: Number(e.target.value) })}
          {...blurAfterPointer}
        />
        <span className="spacer" />
        <button
          className="icon-btn play"
          aria-label={s.pause ? 'Přehrát' : 'Pozastavit'}
          onClick={() => playerCommand({ type: 'togglePause' })}
          {...blurAfterPointer}
        >
          {s.pause ? '▶' : '❚❚'}
        </button>
        <span className="spacer" />
        <button
          className="icon-btn"
          aria-label="Celá obrazovka"
          onClick={() => playerCommand({ type: 'setFullscreen', on: !s.fullscreen })}
          {...blurAfterPointer}
        >
          ⛶
        </button>
      </div>
    </div>
  );
}
