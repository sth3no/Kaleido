import { blurAfterPointer } from '../input/forward';
import { playerCommand } from '../player';
import { formatTime, type PlayerState } from '../playerState';
import { Seekbar } from './Seekbar';

type Props = { s: PlayerState; hidden?: boolean; onMini(): void };

export function Controls({ s, hidden = false, onMini }: Props) {
  return (
    <div className={`capsule glass controls${hidden ? ' hidden' : ''}`} data-glass>
      <div className="row">
        <span className="time">{formatTime(s.timePos)}</span>
        <Seekbar timePos={s.timePos} duration={s.duration} />
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
        <button className="icon-btn" aria-label="Mini přehrávač" onClick={onMini} {...blurAfterPointer}>
          ▣
        </button>
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
