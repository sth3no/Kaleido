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

// The player's controls (key-screens-v2.html, screen 2).
export const PLAY =
  'M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z';
export const PAUSE = 'M7 5h3.5v14H7zm6.5 0H17v14h-3.5z';
export const PREVIOUS = 'M6 5h2v14H6zM9.5 12l9 6.5V5.5z';
export const NEXT = 'M16 5h2v14h-2zM5.5 5.5v13l9-6.5z';
export const VOLUME =
  'M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z';
/** The speaker with a cross in place of the waves. */
export const MUTED = 'M4 9v6h4l5 4V5L8 9H4zm11.4-.5 2.8 2.8L21 8.5l.7.7-2.8 2.8 2.8 2.8-.7.7-2.8-2.8-2.8 2.8-.7-.7 2.8-2.8-2.8-2.8z';
export const SUBTITLES =
  'M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1z';
export const PLAYLIST = 'M3 6h13v2H3zm0 5h13v2H3zm0 5h9v2H3zm15-2v-4l4 3z';
export const FULLSCREEN = 'M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z';
export const EXIT_FULLSCREEN =
  'M8 4h2v6H4V8h4zm6 0h2v4h4v2h-6zM4 14h6v6H8v-4H4zm10 0h6v2h-4v4h-2z';

const VIEW_BOX = '0 0 24 24';

export default function Icon({ path }: { path: string }) {
  return (
    <svg className={styles.icon} viewBox={VIEW_BOX} aria-hidden>
      <path d={path} />
    </svg>
  );
}
