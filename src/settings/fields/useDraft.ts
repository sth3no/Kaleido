/**
 * The text of a field while it is typed into. Nothing is saved while the user types: the text is
 * saved when the field is left or Enter is pressed, in its clean form (`clean`), and only if that
 * is not what the setting already has. Esc drops the text. Not editing, the field shows the value.
 *
 * A text that cannot be right (`check`: a colour that is no colour) is not sent. It stays in the
 * field, as typed, so that it can be corrected, and the row is told why (`onInvalid`, with the key of
 * the text `invalidText`); typing again, Esc or a good text takes the message away. An empty text is
 * always sent: it takes the option out of mpv.conf. Rust checks the value again.
 */

import { useRef, useState, type KeyboardEvent } from 'react';

export interface DraftOptions {
  /** What the setting has now. */
  value: string;
  /** How the field writes `value` when it is not being edited. */
  show: (value: string) => string;
  /** The text in the form that is saved, and compared with `value`. */
  clean: (text: string) => string;
  /** Saves a clean text. */
  save: (text: string) => void;
  /** Whether a clean text that is not empty can be saved; left out, any can. */
  check?: (text: string) => boolean;
  /** The key of the text that says what `check` wants. */
  invalidText?: string;
  onInvalid?: (text: string | null) => void;
}

export interface Draft {
  /** What the field shows. */
  text: string;
  /** The user typed. */
  type: (text: string) => void;
  /** Saves the typed text (the field was left). */
  finish: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
}

export function useDraft({
  value,
  show,
  clean,
  save,
  check,
  invalidText,
  onInvalid,
}: DraftOptions): Draft {
  /** `null` while the field is not being edited. */
  const [draft, setDraft] = useState<string | null>(null);
  /** The row has been told about a text that was refused. */
  const refused = useRef(false);

  /** Takes back what the row was told. */
  const forgive = () => {
    if (!refused.current) return;
    refused.current = false;
    onInvalid?.(null);
  };

  const finish = () => {
    if (draft === null) return;
    const text = clean(draft);
    if (check && text !== '' && !check(text)) {
      refused.current = true;
      onInvalid?.(invalidText ?? null);
      return;
    }
    setDraft(null);
    forgive();
    if (text !== clean(value)) save(text);
  };

  const type = (text: string) => {
    setDraft(text);
    forgive();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      finish();
    } else if (e.key === 'Escape' && draft !== null) {
      // Handled: the typing is dropped, and Esc does not go on to mpv, where it would leave fullscreen.
      e.preventDefault();
      setDraft(null);
      forgive();
    }
  };

  return { text: draft ?? show(value), type, finish, onKeyDown };
}
