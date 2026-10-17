/**
 * The small field for a link (spec 8.5, point 1). "Paste link" and Ctrl+V play the link on the
 * clipboard; when there is none this field appears, and a link typed or pasted into it plays with
 * Enter. Rust checks the text (`system_open_text`); what it says against the text is shown at the
 * field, which stays open with the text in it. Esc (or Cancel) closes it.
 *
 * The focus goes into the field when it opens, and again when `focusToken` changes (Ctrl+V once
 * more while it is open). The one who opened it takes the focus back when it closes (`onClose`).
 * Keys typed in a text field never go on to mpv (src/input/forward.ts), so Ctrl+V here pastes text.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../input/forward';
import { systemOpenText } from '../ipc/commands';
import type { LoadIssue } from '../ipc/types';
import styles from './PasteField.module.css';

export interface PasteFieldProps {
  /** The link went on to play, or the user closed the field (Esc, Cancel). */
  onClose: () => void;
  /** A new value takes the focus into the field. */
  focusToken: number;
}

/** What `system_open_text` rejects with when the text is no link, as opposed to a plain message. */
function isLoadIssue(error: unknown): error is LoadIssue {
  return (
    typeof error === 'object' &&
    error !== null &&
    'kind' in error &&
    (error.kind === 'invalid' || error.kind === 'protocol' || error.kind === 'notFound')
  );
}

/** The text key for why the link did not open. */
function errorKey(error: unknown): string {
  if (isLoadIssue(error)) {
    if (error.kind === 'invalid') return 'home.paste.errors.invalid';
    if (error.kind === 'protocol') return 'home.paste.errors.protocol';
  }
  // Not a link Rust could name, or Tauri could not run the command at all.
  console.warn('system_open_text', error);
  return 'errors.generic';
}

export default function PasteField({ onClose, focusToken }: PasteFieldProps) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The answer is awaited: a second Enter meanwhile would open the link twice.
  const sending = useRef(false);

  useEffect(() => {
    input.current?.focus();
  }, [focusToken]);

  const submit = () => {
    const link = text.trim();
    if (link === '' || sending.current) return;
    sending.current = true;
    systemOpenText(link).then(
      () => {
        sending.current = false;
        onClose();
      },
      (reason: unknown) => {
        sending.current = false;
        setError(errorKey(reason));
        input.current?.focus();
      },
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      // Handled: the key does not go on to mpv, where Esc would leave fullscreen.
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter' && e.target === input.current && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className={styles.field} onKeyDown={onKeyDown}>
      <div className={styles.row}>
        <input
          ref={input}
          type="text"
          className={styles.input}
          value={text}
          placeholder={t('home.paste.placeholder')}
          aria-label={t('home.paste.label')}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />
        <button type="button" className={styles.submit} onClick={submit} {...blurAfterPointer}>
          {t('home.paste.submit')}
        </button>
        <button type="button" className={styles.cancel} onClick={onClose} {...blurAfterPointer}>
          {t('home.paste.cancel')}
        </button>
      </div>
      {error !== null && (
        <p id={errorId} className={styles.error} role="alert">
          {t(error)}
        </p>
      )}
    </div>
  );
}
