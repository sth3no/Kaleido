/**
 * Preferred languages (`slang`, `alang`): language codes of two or three letters in the order of
 * preference, typed into a text field. `cs; EN  de` is saved as `cs,en,de`. It is saved when the
 * field is left or Enter is pressed; an empty field takes the option out of mpv.conf. What Rust
 * refuses (a code that is no code) is said next to the field.
 */

import { useTranslation } from 'react-i18next';

import { normalizeLanguages } from '../values';
import styles from './Fields.module.css';
import type { FieldProps } from './FieldProps';
import { useDraft } from './useDraft';

/** The list as the field writes it: a space after each comma. */
const spaced = (value: string) => value.split(',').join(', ');

export default function LangListField({
  id,
  labelId,
  value,
  onChange,
  describedBy,
  invalid,
  disabled,
}: FieldProps<string>) {
  const { t } = useTranslation();
  const draft = useDraft(value, spaced, normalizeLanguages, onChange);

  return (
    <input
      id={id}
      type="text"
      className={styles.input}
      value={draft.text}
      placeholder={t('settings.fields.langList.placeholder')}
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      aria-invalid={invalid ? true : undefined}
      autoComplete="off"
      spellCheck={false}
      disabled={disabled}
      onChange={(e) => {
        draft.type(e.target.value);
      }}
      onBlur={draft.finish}
      onKeyDown={draft.onKeyDown}
    />
  );
}
