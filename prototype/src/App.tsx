import { Controls } from './components/Controls';
import { StartScreen } from './components/StartScreen';
import { TitleBar } from './components/TitleBar';
import { badgeFor } from './playerState';
import { usePlayer } from './usePlayer';

export function App() {
  const s = usePlayer();
  return (
    <div className={s.loaded ? 'app' : 'app idle-bg'}>
      {!s.loaded && <StartScreen />}
      <TitleBar title={s.title || 'Kaleido M0'} badge={badgeFor(s)} />
      {s.loaded && <Controls s={s} />}
    </div>
  );
}
