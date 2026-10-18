/**
 * One setting on the page: its label (a `<label for>` the field, so that a click on it works the
 * control) and a short hint under it on the left, the field on the right, and under the field, when
 * the last change was refused (by Rust, or by the field itself: a text that cannot be right), why.
 * The change itself is saved at once by `useSetting`; the message is a `role="alert"`, so that a
 * screen reader says it, and it describes the field (`aria-describedby`) until the next change.
 */

import { useId, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { SettingDescriptor } from './descriptors';
import SettingField from './SettingField';
import styles from './SettingRow.module.css';
import { useSetting } from './useSetting';

export interface SettingRowProps {
  descriptor: SettingDescriptor;
}

export default function SettingRow({ descriptor }: SettingRowProps) {
  const { t } = useTranslation();
  const ids = useId();
  const control = useSetting(descriptor);
  const fieldId = `${ids}-field`;
  const labelId = `${ids}-label`;
  const hintId = `${ids}-hint`;
  const errorId = `${ids}-error`;
  const hint = descriptor.hintKey;
  const describedBy =
    [hint === undefined ? '' : hintId, control.error === null ? '' : errorId]
      .filter((id) => id !== '')
      .join(' ') || undefined;

  /** Whether the list of the field was open when the pointer went down on the label. */
  const listWasOpen = useRef(false);

  const onLabelMouseDown = () => {
    // Before the press moves the focus, which closes a list.
    listWasOpen.current = document.getElementById(fieldId)?.getAttribute('aria-expanded') === 'true';
  };

  /**
   * A click on the label works the control, as a `<label for>` does, but not by the label's own
   * action, which leaves a button focused after the pointer (Space would then press it again instead
   * of going to mpv; the convention is `blurAfterPointer`):
   * - a switch or the button of a list is clicked, and after a pointer it is let go of. A list that
   *   was open when the pointer went down is closed by the press itself (the focus leaves it), and
   *   that is the toggle: it is not clicked again, which would open it again;
   * - a text field gets the focus, the way to put the cursor there;
   * - a slider is not focused by a pointer (as with a click on the slider itself).
   * A click that is not a pointer's (`detail` 0: a screen reader) leaves the focus where it put it.
   */
  const onLabelClick = (e: ReactMouseEvent<HTMLLabelElement>) => {
    const element = document.getElementById(fieldId);
    const byPointer = e.detail > 0;
    // What the press recorded counts for the click of that press only. A press that never made a click
    // (a right button, a drag away from the label) leaves it behind, and a click that is not a
    // pointer's (no press before it) must not find it: only a pointer's click reads it, and every
    // press sets it again first.
    const closedByPress =
      byPointer && listWasOpen.current && element?.getAttribute('aria-expanded') !== 'true';
    listWasOpen.current = false;
    if (!(element instanceof HTMLElement)) return;
    e.preventDefault();
    if (element instanceof HTMLButtonElement) {
      if (!closedByPress) element.click();
      if (byPointer) element.blur();
    } else if (element instanceof HTMLInputElement && element.type === 'text') {
      element.focus();
    } else if (!byPointer) {
      element.focus();
    }
  };

  // The list of shaders is a group of checkboxes, not a control a label can be for.
  const labelText = t(descriptor.labelKey);
  const label =
    descriptor.field.kind === 'shaderList' ? (
      <span id={labelId} className={styles.label}>
        {labelText}
      </span>
    ) : (
      <label
        id={labelId}
        htmlFor={fieldId}
        className={styles.label}
        onMouseDown={onLabelMouseDown}
        onClick={onLabelClick}
      >
        {labelText}
      </label>
    );

  return (
    <div className={styles.row} data-setting={descriptor.id}>
      <div className={styles.text}>
        {label}
        {hint !== undefined && (
          <span id={hintId} className={styles.hint}>
            {t(hint)}
          </span>
        )}
      </div>
      <div className={styles.control}>
        <SettingField
          descriptor={descriptor}
          id={fieldId}
          labelId={labelId}
          value={control.value}
          onChange={control.save}
          onInvalid={control.reject}
          describedBy={describedBy}
          invalid={control.error !== null}
          disabled={!control.ready}
        />
        {control.error !== null && (
          <p id={errorId} className={styles.error} role="alert">
            {t(control.error)}
          </p>
        )}
      </div>
    </div>
  );
}
