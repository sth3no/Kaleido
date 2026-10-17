/**
 * The player page (spec 8.4), the page over the video (AppShell.tsx passes it in): the bottom
 * island, the autohide and the black curtain over a switch to or from fullscreen. The page layer
 * lets the pointer through to the video; the island takes it again.
 *
 * The islands hide after 2.5 s without movement while the video plays (`useAutohide`): this
 * island fades out, and when it has faded it is taken away, so that nothing of it is measured,
 * drawn or kept running while it is hidden (spec 13: hidden controls do not repaint, and the
 * clock that moves the seekbar stops with them). It comes back with a fade.
 *
 * Later tasks add what else the page shows: the indicator, the loading title, the error card
 * (Tasks 19) and the panels above the controls (Task 20).
 */

import { createPortal } from 'react-dom';

import { useFullscreenCurtain } from './fullscreen';
import ControlsIsland from './ControlsIsland';
import styles from './PlayerPage.module.css';
import { useAutohide, useLinger } from './useAutohide';

/** A little more than the island's fade (`--k-motion-base`, 200 ms), so that it has finished. */
export const FADE_OUT_MS = 250;

export default function PlayerPage() {
  const hidden = useAutohide();
  const curtain = useFullscreenCurtain();
  const present = useLinger(!hidden, FADE_OUT_MS);

  return (
    <>
      {present && <ControlsIsland hidden={hidden} />}
      {/* Over everything, the islands of the shell too: in the body, not in the page. */}
      {createPortal(<div className={styles.curtain} data-on={curtain} aria-hidden />, document.body)}
    </>
  );
}
