import { open } from '@tauri-apps/plugin-dialog';
import { openFile } from '../player';

const VIDEO = ['mkv', 'mp4', 'm4v', 'webm', 'mov', 'avi', 'ts', 'm2ts', 'y4m'];

export function StartScreen() {
  async function pick() {
    const path = await open({ multiple: false, directory: false, filters: [{ name: 'Video', extensions: VIDEO }] });
    if (typeof path === 'string') await openFile(path);
  }
  return (
    <div className="start">
      <div className="start-card glass">
        <div className="title">Kaleido M0 · ověřovací prototyp</div>
        <button className="btn" onClick={pick}>Otevřít soubor</button>
      </div>
    </div>
  );
}
