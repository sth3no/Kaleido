import styles from './App.module.css';
import HomeScreen from './home/HomeScreen';
import { useDrop } from './home/useDrop';
import PlayerPage from './player/PlayerPage';
import PluginsPage from './plugins/PluginsPage';
import SettingsPage from './settings/SettingsPage';
import AppShell from './shell/AppShell';
import ErrorCards from './shell/notices/ErrorCards';

/**
 * The app: the window's shell with its pages: the start screen (Task 17), the player (Task 18),
 * My plugins (M2, Task 13) and the settings (Task 22). The error cards (Task 19) are the shell's
 * notice layer, over every page.
 */
export default function App() {
  // The whole window takes drops, whichever page is shown; the start screen lights up its zone.
  const dragging = useDrop();
  return (
    <div className={styles.root}>
      <AppShell
        home={<HomeScreen dragging={dragging} />}
        player={<PlayerPage />}
        plugins={<PluginsPage />}
        settings={<SettingsPage />}
        notices={<ErrorCards />}
      />
    </div>
  );
}
