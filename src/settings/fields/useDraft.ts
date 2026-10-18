/**
 * The text of a field while it is typed into. Nothing is saved while the user types: the text is
 * saved when the field is left or Enter is pressed, in its clean form (`clean`), and only if that
 * is not what the setting already has. Esc drops the text. Not editing, the field shows the value.
 */

import { useState, type KeyboardEvent } from 'react';

export interface Draft {
  /** What the field shows. */
  text: string;
  /** The user typed. */
  type: (text: string) => void;
  /** Saves the typed text (the field was left). */
  finish: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * @param value what the setting has now
 * @param show how the field writes `value` when it is not being edited
 * @param clean the text in the form that is saved, and compared with `value`
 * @param save saves a clean text
 */
export function useDraft(
  value: string,
  show: (value: string) => string,
  clean: (text: string) => string,
  save: (text: string) => void,
): Draft {
  /** `null` while the field is not being edited. */
  const [draft, setDraft] = useState<string | null>(null);

  const finish = () => {
    if (draft === null) return;
    setDraft(null);
    const text = clean(draft);
    if (text !== clean(value)) save(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      finish();
    } else if (e.key === 'Escape' && draft !== null) {
      // Handled: the typing is dropped, and Esc does not go on to mpv, where it would leave fullscreen.
      e.preventDefault();
      setDraft(null);
    }
  };

  return { text: draft ?? show(value), type: setDraft, finish, onKeyDown };
}
