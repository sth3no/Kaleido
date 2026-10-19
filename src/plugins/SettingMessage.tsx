/**
 * What is wrong with a setting, under its field: the sentence, as an alert (a screen reader says it),
 * and where Rust refused the value, Rust's own reason after it. The reason is English whatever the
 * language of the UI (Rust's literals), so it says so (`lang`).
 */

import { useTranslation } from 'react-i18next';

import styles from './PluginSettings.module.css';
import type { SettingProblem } from './settingValue';

export interface SettingMessageProps {
  /** The id the field's `aria-describedby` points at. */
  id: string;
  problem: SettingProblem;
}

export default function SettingMessage({ id, problem }: SettingMessageProps) {
  const { t } = useTranslation();

  return (
    <p id={id} role="alert" className={styles.error}>
      {problem.text}
      {problem.detail !== undefined && (
        <>
          {' '}
          <span className={styles.detail}>
            {t('plugins.settings.reason')} <span lang="en">{problem.detail}</span>
          </span>
        </>
      )}
    </p>
  );
}
