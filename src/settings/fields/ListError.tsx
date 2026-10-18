/**
 * What a field shows under itself when the list it needs (the fonts, the audio devices, the shader
 * files) could not be read: it says so, and "Try again" asks again (`useRustList`). Said as an alert,
 * since it appears on its own.
 */

import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../../input/forward';
import styles from './Fields.module.css';

export interface ListErrorProps {
  onRetry: () => void;
}

export default function ListError({ onRetry }: ListErrorProps) {
  const { t } = useTranslation();
  return (
    <div role="alert" className={styles.listError}>
      <span>{t('settings.fields.listFailed')}</span>
      <button type="button" className={styles.retry} onClick={onRetry} {...blurAfterPointer}>
        {t('settings.retry')}
      </button>
    </div>
  );
}
