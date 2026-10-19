/**
 * A text field of the plugin settings: a number, a string, the value of a key. The text is saved
 * when the field is left or Enter is pressed, and Esc drops it (`useDraft`, as every text field of
 * the settings page works). Not editing, the field shows the stored value, so a value that was not
 * kept (Rust refused it) is back in the field as soon as the save is over.
 *
 * With `check`, a text that cannot be right is not sent: it stays in the field, as typed, so that
 * it can be corrected, and `onInvalid(true)` says so (`false` again when it is typed over, dropped
 * or good); the row writes the sentence itself. `onEdit` hears every key typed, so that a message
 * about the last save can go.
 */

import type { Ref } from 'react';

import fields from '../settings/fields/Fields.module.css';
import { useDraft } from '../settings/fields/useDraft';

const same = (text: string): string => text;

/** `useDraft` reports a text it refuses with the key of a sentence; the rows here write their own. */
const REFUSED = 'refused';

export interface DraftInputProps {
  id?: string;
  /** The id of the element that names the field. */
  labelId: string;
  value: string;
  /** A text to save. */
  onChange: (text: string) => void;
  /** How the text is written for saving and compared with `value`; left out, as typed. */
  clean?: (text: string) => string;
  /** Whether a text that is not empty can be saved; left out, any can. */
  check?: (text: string) => boolean;
  onInvalid?: (invalid: boolean) => void;
  onEdit?: () => void;
  describedBy?: string;
  /** The last save was refused, or the text is no good. */
  invalid?: boolean;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}

export default function DraftInput({
  id,
  labelId,
  value,
  onChange,
  clean = same,
  check,
  onInvalid,
  onEdit,
  describedBy,
  invalid,
  disabled,
  inputRef,
}: DraftInputProps) {
  const draft = useDraft({
    value,
    show: same,
    clean,
    save: onChange,
    check,
    invalidText: REFUSED,
    onInvalid: (text) => {
      onInvalid?.(text !== null);
    },
  });

  return (
    <input
      ref={inputRef}
      id={id}
      type="text"
      className={fields.input}
      value={draft.text}
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      aria-invalid={invalid ? true : undefined}
      autoComplete="off"
      spellCheck={false}
      disabled={disabled}
      onChange={(e) => {
        draft.type(e.target.value);
        onEdit?.();
      }}
      onBlur={draft.finish}
      onKeyDown={draft.onKeyDown}
    />
  );
}
