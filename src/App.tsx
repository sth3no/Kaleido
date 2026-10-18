import styles from './App.module.css';
import HomeScreen from './home/HomeScreen';
import { useDrop } from './home/useDrop';
import ErrorCards from './player/ErrorCards';
import PlayerPage from './player/PlayerPage';
import AppShell from './shell/AppShell';

/**
 * The app: the window's shell with its pages. The pages come with the tasks that build them: the
 * start screen (Task 17), the player (Task 18) and the settings (Task 22). The error cards (Task
 * 19) are the shell's notice layer, over every page.
 */
export default function App() {
  // The whole window takes drops, whichever page is shown; the start screen lights up its zone.
  const dragging = useDrop();
  return (
    <div className={styles.root}>
      <AppShell
        home={<HomeScreen dragging={dragging} />}
        player={<PlayerPage />}
        settings={null}
        notices={<ErrorCards />}
      />
    </div>
  );
}
