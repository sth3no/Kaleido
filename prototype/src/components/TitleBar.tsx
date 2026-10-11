import { getCurrentWindow } from '@tauri-apps/api/window';

export function TitleBar({ title, badge }: { title: string; badge?: string }) {
  const win = getCurrentWindow();
  return (
    <>
      <div className="capsule glass titlebar-left" data-tauri-drag-region data-glass>
        <span className="dot" data-tauri-drag-region />
        <span className="title" data-tauri-drag-region>{title}</span>
        {badge && <span className="badge">{badge}</span>}
      </div>
      <div className="capsule glass titlebar-right" data-glass>
        <button className="icon-btn" aria-label="Minimalizovat" onClick={() => win.minimize()}>–</button>
        <button className="icon-btn" aria-label="Maximalizovat" onClick={() => win.toggleMaximize()}>□</button>
        <button className="icon-btn" aria-label="Zavřít" onClick={() => win.close()}>✕</button>
      </div>
    </>
  );
}
