/**
 * The bottom layer of the shell: a transparent element over the whole window, where mpv's own
 * window is in the normal layout (spec 5.1). What the pointer does on it (moves, buttons, the
 * wheel) and every key the UI does not handle go to mpv (`attachVideoInput`): it turns the
 * pointer's position into mpv's window pixels against this element's rectangle, so the element
 * has to cover exactly what mpv's window covers, the whole client area.
 *
 * While mpv's window is somewhere else (the mini player and the animation to it,
 * surface/useSurfaceLayout.ts) the pointer is not passed on (`pointer`, Ruling R45): its place
 * here would be the wrong place in mpv's window, and the mini player takes the pointer over the
 * video itself. Nor while no video is shown (the start screen, the settings; Ruling R52): the
 * wheel there would change the volume unseen, and a double click turn the start screen
 * fullscreen. The keyboard goes to mpv either way.
 *
 * It stays mounted on every page: the keys of input.conf (Ctrl+V, Ctrl+O, …) work without a video
 * too. Anything above it that is not a control lets the pointer through to it (AppShell.module.css).
 */

import { useEffect, useLayoutEffect, useRef } from 'react';

import { attachVideoInput } from '../input/forward';
import styles from './VideoLayer.module.css';

export interface VideoLayerProps {
  /** Whether the pointer over the layer goes to mpv: while mpv's window fills the player page. */
  pointer?: boolean;
}

export default function VideoLayer({ pointer = true }: VideoLayerProps) {
  const layer = useRef<HTMLDivElement>(null);
  const forwarding = useRef(pointer);
  // Before anything can happen on the layer in the new layout.
  useLayoutEffect(() => {
    forwarding.current = pointer;
  }, [pointer]);

  useEffect(() => {
    const element = layer.current;
    if (!element) return undefined;
    return attachVideoInput(element, { pointer: () => forwarding.current });
  }, []);

  // `data-video-layer`: a press on it is a press on the bare video (panels/Popover.tsx).
  return <div ref={layer} className={styles.layer} data-video-layer data-pointer={pointer} />;
}
