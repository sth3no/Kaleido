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

/** A puzzle piece: the plugins. */
export const PLUGINS =
  'M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.7 2.7 0 0 1 0 5.4H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.7 2.7 0 0 1 5.4 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z';

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

// Feedback over the video: the indicator, the loading title and the notices (Task 19).
/** Two arrows to the right: the speed. */
export const FAST_FORWARD = 'M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z';
/** A clock: the place in the file. */
export const CLOCK =
  'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z';
/** A triangle with a mark: a file that cannot be played. */
export const WARNING = 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z';
export const INFO =
  'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z';
export const CHEVRON_DOWN = 'M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z';

// The mini player (Task 21).
/** Two arrows out to the corners: back to the whole window. */
export const EXPAND =
  'M14 4h6v6h-2V7.41l-4.29 4.3-1.42-1.42L16.59 6H14zM10 20H4v-6h2v2.59l4.29-4.3 1.42 1.42L7.41 18H10z';
export const STOP = 'M6 6h12v12H6z';

// The panels above the controls (Task 20).
export const PLUS = 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z';
export const MINUS = 'M19 13H5v-2h14z';
export const CHECK = 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z';
/** Two columns of three dots: the grip of a row that can be dragged. */
export const GRIP =
  'M7.4 6a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0zM13.4 6a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0zM7.4 12a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0zM13.4 12a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0zM7.4 18a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0zM13.4 18a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0z';

const VIEW_BOX = '0 0 24 24';

export default function Icon({ path }: { path: string }) {
  return (
    <svg className={styles.icon} viewBox={VIEW_BOX} aria-hidden>
      <path d={path} />
    </svg>
  );
}
