/**
 * The shaders (`glsl-shaders`): a checkbox for each file in the shaders folder, read when the field
 * shows. They are applied in the order they were turned on, so a file turned on goes to the end of
 * the list. A shader the option names that is not in the folder (a line of the user's own
 * mpv.conf) is listed too, so that it can be turned off. The value saved is
 * `~~/shaders/<name>` for each, joined by `;` (`formatShaders`).
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { settingsListShaders } from '../../ipc/commands';
import styles from './Fields.module.css';
import type { FieldProps } from './FieldProps';
import { useRustList } from './useRustList';

export default function ShaderListField({
  id,
  labelId,
  value,
  onChange,
  describedBy,
  disabled,
}: FieldProps<readonly string[]>) {
  const { t } = useTranslation();
  const files = useRustList(settingsListShaders, 'settings_list_shaders');
  const names = useMemo(
    () => [...(files ?? []), ...value.filter((name) => !(files ?? []).includes(name))],
    [files, value],
  );

  if (files !== null && names.length === 0) {
    return (
      <p id={id} className={styles.empty}>
        {t('settings.fields.shaders.empty')}
      </p>
    );
  }

  return (
    <div
      id={id}
      role="group"
      className={styles.checks}
      aria-labelledby={labelId}
      aria-describedby={describedBy}
    >
      {names.map((name) => (
        <label key={name} className={styles.check}>
          <input
            type="checkbox"
            checked={value.includes(name)}
            disabled={disabled === true || files === null}
            onChange={(e) => {
              onChange(e.target.checked ? [...value, name] : value.filter((on) => on !== name));
            }}
          />
          <span className={styles.checkName}>{name}</span>
        </label>
      ))}
    </div>
  );
}
