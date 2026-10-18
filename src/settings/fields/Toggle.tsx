/**
 * An on/off switch (`role="switch"`): Space and Enter flip it, as they do any button, and the row's
 * label names it. The words it saves are the setting's (`yes` and `no`, or `filter` and `no` for the
 * playlist from the folder); the switch itself only knows on and off.
 */

import { blurAfterPointer } from '../../input/forward';
import styles from './Fields.module.css';
import type { FieldProps } from './FieldProps';

export default function Toggle({
  id,
  labelId,
  value,
  onChange,
  describedBy,
  invalid,
  disabled,
}: FieldProps<boolean>) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      className={styles.switch}
      aria-checked={value}
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      data-invalid={invalid ? '' : undefined}
      disabled={disabled}
      onClick={() => {
        onChange(!value);
      }}
      {...blurAfterPointer}
    />
  );
}
