/**
 * A colour as mpv writes it, `#RRGGBB` or `#AARRGGBB` (alpha first, so `#80000000` is half-clear
 * black), typed into a text field with the colour beside it as a swatch over a chequerboard. It is
 * saved when the field is left or Enter is pressed; the browser's colour picker is not used: it
 * opens a popup of its own, outside the page (see `Dropdown`), and has no alpha.
 *
 * Text that is no colour is not sent: the row says so (`onInvalid`) and the text stays in the field
 * to be corrected (see `useDraft`). An empty field takes the option out of mpv.conf.
 */

import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import { cssColor, isColor, normalizeColor } from '../values';
import styles from './Fields.module.css';
import type { FieldProps } from './FieldProps';
import { useDraft } from './useDraft';

const same = (value: string) => value;

const INVALID_TEXT = 'settings.errors.invalidColor';

export default function ColorField({
  id,
  labelId,
  value,
  onChange,
  onInvalid,
  describedBy,
  invalid,
  disabled,
}: FieldProps<string>) {
  const { t } = useTranslation();
  const draft = useDraft({
    value,
    show: same,
    clean: normalizeColor,
    save: onChange,
    check: isColor,
    invalidText: INVALID_TEXT,
    onInvalid,
  });
  const swatch = cssColor(normalizeColor(draft.text));

  return (
    <div className={styles.color}>
      <span
        className={styles.swatch}
        style={swatch === undefined ? undefined : ({ '--swatch': swatch } as CSSProperties)}
        aria-hidden
      />
      <input
        id={id}
        type="text"
        className={styles.input}
        value={draft.text}
        placeholder={t('settings.fields.color.placeholder')}
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
    </div>
  );
}
