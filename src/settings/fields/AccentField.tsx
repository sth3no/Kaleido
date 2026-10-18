/**
 * The accent colour: Kaleido's own (the rainbow, `kaleido`) or one colour of the user's, `#RRGGBB`.
 * Two choices that exclude each other, as a radio group (the arrows move between them and choose,
 * and Tab reaches the one that is chosen), and, with the colour chosen, its text beside a swatch.
 * The text is saved when the field is left or Enter is pressed, like the other colours (see
 * `ColorField`); the browser's colour picker is not used for the reason given there.
 *
 * Going back to "my colour" brings back the one the user had last, else a violet to start from.
 */

import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../../input/forward';
import { KALEIDO_GRADIENT, KALEIDO_SOLID } from '../../theme/tokens';
import { cssColor, isOpaqueColor, normalizeColor } from '../values';
import styles from './Fields.module.css';
import type { FieldProps } from './FieldProps';
import { useDraft } from './useDraft';

/** The setting's word for the rainbow (Rust: `ACCENT_KALEIDO`). */
export const ACCENT_KALEIDO = 'kaleido';

/** The colour "my colour" starts from: the violet of the rainbow. */
export const STARTING_ACCENT = KALEIDO_SOLID.toUpperCase();

const same = (value: string) => value;

/** The two choices, in the order of the group. */
const CHOICES = ['kaleido', 'custom'] as const;

export default function AccentField({
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
  const custom = value !== ACCENT_KALEIDO;
  /** The colour of the user's the last time there was one. */
  const remembered = useRef(STARTING_ACCENT);
  useEffect(() => {
    if (isOpaqueColor(value)) remembered.current = value;
  }, [value]);

  const choices = useRef<(HTMLButtonElement | null)[]>([]);
  const draft = useDraft({
    value: custom ? value : '',
    show: same,
    clean: normalizeColor,
    save: onChange,
    check: isOpaqueColor,
    invalidText: 'settings.errors.invalidColorOpaque',
    onInvalid,
  });
  const swatch = custom ? cssColor(normalizeColor(draft.text)) : undefined;

  const choose = (index: number) => {
    if (index === 0) {
      if (custom) onChange(ACCENT_KALEIDO);
    } else if (!custom) {
      onChange(remembered.current);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const at = choices.current.findIndex((choice) => choice === document.activeElement);
    if (at < 0) return;
    const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const backward = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    if (!forward && !backward) return;
    // Handled here: mpv does not get the arrow too. Like a radio group, the focus chooses.
    e.preventDefault();
    const next = (at + (forward ? 1 : choices.current.length - 1)) % choices.current.length;
    choices.current[next]?.focus();
    choose(next);
  };

  return (
    <div className={styles.accent}>
      <div
        id={id}
        role="radiogroup"
        className={styles.choices}
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        onKeyDown={onKeyDown}
      >
        {CHOICES.map((name, index) => {
          const checked = (name === 'custom') === custom;
          return (
            <button
              key={name}
              ref={(element) => {
                choices.current[index] = element;
              }}
              type="button"
              role="radio"
              className={styles.choice}
              aria-checked={checked}
              data-invalid={invalid ? '' : undefined}
              tabIndex={checked ? 0 : -1}
              disabled={disabled}
              onClick={() => {
                choose(index);
              }}
              {...blurAfterPointer}
            >
              {name === 'kaleido' && (
                <span className={styles.rainbow} style={{ background: KALEIDO_GRADIENT }} aria-hidden />
              )}
              {t(`settings.fields.accent.${name}`)}
            </button>
          );
        })}
      </div>
      {custom && (
        <div className={styles.color}>
          <span
            className={styles.swatch}
            style={swatch === undefined ? undefined : ({ '--swatch': swatch } as CSSProperties)}
            aria-hidden
          />
          <input
            type="text"
            className={styles.input}
            value={draft.text}
            placeholder={t('settings.fields.color.placeholderOpaque')}
            aria-label={t('settings.fields.accent.colour')}
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
      )}
    </div>
  );
}
