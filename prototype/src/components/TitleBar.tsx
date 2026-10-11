import { getCurrentWindow } from '@tauri-apps/api/window';
import { blurAfterPointer } from '../input/forward';

type Props = { title: string; badge?: string; hidden?: boolean };

export function TitleBar({ title, badge, hidden = false }: Props) {
  const win = getCurrentWindow();
  const capsule = (side: 'left' | 'right') => `capsule glass titlebar-${side}${hidden ? ' hidden' : ''}`;
  return (
    <>
      <div className={capsule('left')} data-tauri-drag-region data-glass>
        <span className="dot" data-tauri-drag-region />
        <span className="title" data-tauri-drag-region>{title}</span>
        {badge && <span className="badge">{badge}</span>}
      </div>
      <div className={capsule('right')} data-glass>
        <button className="icon-btn" aria-label="Minimalizovat" onClick={() => win.minimize()} {...blurAfterPointer}>–</button>
        <button className="icon-btn" aria-label="Maximalizovat" onClick={() => win.toggleMaximize()} {...blurAfterPointer}>□</button>
        <button className="icon-btn" aria-label="Zavřít" onClick={() => win.close()} {...blurAfterPointer}>✕</button>
      </div>
    </>
  );
}
