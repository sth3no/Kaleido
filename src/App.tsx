import styles from './App.module.css';
import AppShell from './shell/AppShell';

/**
 * The app: the window's shell with its pages. The pages come with the tasks that build them: the
 * start screen (Task 17), the player (Task 18) and the settings (Task 22).
 */
export default function App() {
  return (
    <div className={styles.root}>
      <AppShell home={null} player={null} settings={null} />
    </div>
  );
}
