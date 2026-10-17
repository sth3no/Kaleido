/**
 * The icons of the shell, from the mockups' sprite (key-screens-v2.html): 24×24 paths filled with
 * the text colour. An icon is decorative; the control it sits in carries the label.
 */

import styles from './Icon.module.css';

export const MENU = 'M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z';
export const MINIMIZE = 'M5 11h14v2H5z';
export const MAXIMIZE = 'M5 5h14v14H5zm2 2v10h10V7z';
/** Two windows, the back one peeking out: the window is maximised and this restores it. */
export const RESTORE = 'M8 4h12v12h-2V6H8zM4 8h12v12H4zm2 2v8h8v-8z';
export const CLOSE =
  'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z';
export const PLAYER = 'M4 4h16v16H4zm2 2v2h2V6zm10 0v2h2V6zM6 10v4h12v-4zm0 6v2h2v-2zm10 0v2h2v-2z';
export const SETTINGS =
  'M18.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.4-2.5 1a7.4 7.4 0 0 0-1.7-1L14 3.3h-4l-.4 2.7a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.4L5.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.4 2.5-1a7.4 7.4 0 0 0 1.7 1l.4 2.7h4l.4-2.7a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.4zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z';

export const FOLDER =
  'M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z';
export const LINK =
  'M10.6 13.4a1 1 0 0 0 1.4 1.4l4.6-4.6a3 3 0 0 0-4.2-4.2l-2 2 1.4 1.4 2-2a1 1 0 0 1 1.4 1.4zm2.8-2.8a1 1 0 0 0-1.4-1.4l-4.6 4.6a3 3 0 0 0 4.2 4.2l2-2-1.4-1.4-2 2a1 1 0 0 1-1.4-1.4z';

const VIEW_BOX = '0 0 24 24';

export default function Icon({ path }: { path: string }) {
  return (
    <svg className={styles.icon} viewBox={VIEW_BOX} aria-hidden>
      <path d={path} />
    </svg>
  );
}
