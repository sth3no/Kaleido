/**
 * One setting on the page: its label (and a short hint under it) on the left, the field on the
 * right, and under the field, when Rust refused the last change, why. The change itself is saved at
 * once by `useSetting`; the message is a `role="alert"`, so that a screen reader says it, and it
 * describes the field (`aria-describedby`) until the next change.
 */

import { useId } from 'react';
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

  return (
    <div className={styles.row} data-setting={descriptor.id}>
      <div className={styles.text}>
        <span id={labelId} className={styles.label}>
          {t(descriptor.labelKey)}
        </span>
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
