/**
 * The start screen, shown while nothing is open (spec 8.5, point 1; key-screens-v2.html, screen 1):
 *
 * - The drop zone. Dropping is the window's (`useDrop`, mounted by the app): the zone lights up
 *   while something is dragged over the window (`dragging`).
 * - "Open file" asks Rust for the open dialog; "Paste link" (Ctrl+V) plays the link on the
 *   clipboard, and when there is none shows the paste field. Ctrl+V goes through input.conf to
 *   Rust, which says `system:paste-empty` when it found no link: the field appears for that too.
 * - "Continue watching" is on the roadmap (M4): the card says so, and so does "What we are
 *   building →"; both open the public roadmap.
 *
 * What opens switches the app to the player: the bridge listens to `system:open-request`, and a
 * link dropped on the window does it itself (`useDrop`).
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../input/forward';
import { systemOpenDialog, systemOpenRoadmap, systemPaste } from '../ipc/commands';
import { onPasteEmpty } from '../ipc/events';
import { listenTo } from '../ipc/listen';
import Icon, { FOLDER, LINK } from '../shell/Icon';
import glass from '../theme/glass.module.css';
import styles from './HomeScreen.module.css';
import PasteField from './PasteField';

export interface HomeScreenProps {
  /** Something is being dragged over the window. */
  dragging?: boolean;
}

const warn = (what: string) => (error: unknown) => {
  console.warn(what, error);
};

export default function HomeScreen({ dragging = false }: HomeScreenProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const resumeId = useId();
  const pasteButton = useRef<HTMLButtonElement>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [focusToken, setFocusToken] = useState(0);

  const showPaste = useCallback(() => {
    setPasteOpen(true);
    setFocusToken((token) => token + 1);
  }, []);
  // The focus goes back to the button that offers the field.
  const closePaste = useCallback(() => {
    setPasteOpen(false);
    pasteButton.current?.focus();
  }, []);

  // Ctrl+V found no link on the clipboard.
  useEffect(() => listenTo(onPasteEmpty, showPaste, 'system:paste-empty'), [showPaste]);

  const openFile = () => {
    systemOpenDialog('media').catch(warn('system_open_dialog'));
  };

  const pasteLink = () => {
    systemPaste().then(
      (outcome) => {
        if (outcome === 'empty') showPaste();
      },
      (error: unknown) => {
        // The field is the way to paste a link without the clipboard.
        console.warn('system_paste', error);
        showPaste();
      },
    );
  };

  const openRoadmap = () => {
    systemOpenRoadmap().catch(warn('system_open_roadmap'));
  };

  return (
    <div className={styles.home}>
      <div className={styles.content}>
        <section
          className={`${glass.glass} ${styles.zone}`}
          aria-labelledby={titleId}
          data-dragging={dragging}
        >
          <div className={styles.orb} aria-hidden />
          <h1 id={titleId} className={styles.title}>
            {t('home.title')}
          </h1>
          <p className={styles.subtitle}>{t('home.subtitle')}</p>
          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              onClick={openFile}
              {...blurAfterPointer}
            >
              <Icon path={FOLDER} />
              {t('home.openFile')}
            </button>
            <button
              ref={pasteButton}
              type="button"
              className={`${styles.button} ${styles.ghost}`}
              onClick={pasteLink}
              aria-keyshortcuts="Control+V"
              {...blurAfterPointer}
            >
              <Icon path={LINK} />
              {t('home.pasteLink')}
              {/* The button's name stays "Paste link"; the shortcut is aria-keyshortcuts. */}
              <kbd className={styles.kbd} aria-hidden>
                {t('home.pasteShortcut')}
              </kbd>
            </button>
          </div>
          {pasteOpen && <PasteField onClose={closePaste} focusToken={focusToken} />}
        </section>

        <section className={`${glass.glass} ${styles.resume}`} aria-labelledby={resumeId}>
          <div className={styles.resumeText}>
            <div className={styles.resumeHeading}>
              <h2 id={resumeId} className={styles.resumeTitle}>
                {t('home.resume.title')}
              </h2>
              <span className={styles.badge}>{t('home.resume.badge')}</span>
            </div>
            <p className={styles.resumeSubtitle}>{t('home.resume.text')}</p>
          </div>
          {/* Its ::after covers the card: the card opens the roadmap, with one button to reach. */}
          <button
            type="button"
            className={`${styles.button} ${styles.ghost} ${styles.small} ${styles.roadmap}`}
            onClick={openRoadmap}
            {...blurAfterPointer}
          >
            {t('home.resume.roadmap')}
          </button>
        </section>
      </div>
    </div>
  );
}
