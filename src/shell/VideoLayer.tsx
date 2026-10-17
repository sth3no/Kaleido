/**
 * The bottom layer of the shell: a transparent element over the whole window, where mpv's own
 * window is in the normal layout (spec 5.1). What the pointer does on it (moves, buttons, the
 * wheel) and every key the UI does not handle go to mpv (`attachVideoInput`): it turns the
 * pointer's position into mpv's window pixels against this element's rectangle, so the element
 * has to cover exactly what mpv's window covers, the whole client area.
 *
 * It stays mounted on every page: the keys of input.conf (Ctrl+V, Ctrl+O, …) work without a video
 * too. Anything above it that is not a control lets the pointer through to it (AppShell.module.css).
 */

import { useEffect, useRef } from 'react';

import { attachVideoInput } from '../input/forward';
import styles from './VideoLayer.module.css';

export default function VideoLayer() {
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = layer.current;
    if (!element) return undefined;
    return attachVideoInput(element);
  }, []);

  return <div ref={layer} className={styles.layer} />;
}
