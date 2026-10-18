/**
 * The preview of the appearance settings (spec 8.5 point 4): three islands of glass over a sample
 * gradient, in the colours, the glass and the shapes the settings give. It needs no video: the
 * gradient has sharp edges for the blur to show on. It is drawn with its own copy of the design
 * tokens (`tokensFromAppearance`, `toCssVariables`) on its own element and never touches the root,
 * which `useAppearance` owns; the islands take everything from those variables, as the real ones do.
 *
 * It is a picture to a screen reader: one label for the whole of it.
 */

import { useMemo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import { formatTime } from '../../i18n/format';
import type { Appearance, SystemAppearance } from '../../ipc/types';
import Icon, { PLAY } from '../../shell/Icon';
import glass from '../../theme/glass.module.css';
import { toCssVariables } from '../../theme/tokens';
import { resolveRoot } from '../../theme/useAppearance';
import styles from './AppearancePreview.module.css';

export interface AppearancePreviewProps {
  appearance: Appearance;
  system: SystemAppearance;
  /** Whether the dark scheme is wanted where the mode is "system". */
  prefersDark: boolean;
  /** Rust's word on the glass (`glass:state`); off, the glass is opaque here as it is in the app. */
  glassOn: boolean;
}

/** Where the sample "video" is, for the clock in the controls. */
const POSITION = 724;
const DURATION = 2900;

export default function AppearancePreview({
  appearance,
  system,
  prefersDark,
  glassOn,
}: AppearancePreviewProps) {
  const { t } = useTranslation();
  const resolved = useMemo(
    () => resolveRoot(appearance, system, prefersDark, glassOn),
    [appearance, system, prefersDark, glassOn],
  );
  const variables = useMemo(() => toCssVariables(resolved.tokens), [resolved]);

  return (
    <div
      className={styles.stage}
      style={variables as CSSProperties}
      role="img"
      aria-label={t('settings.appearance.preview.label')}
      data-theme={resolved.theme}
      data-reduce-transparency={resolved.reduceTransparency ? 'true' : undefined}
    >
      <div className={`${glass.glass} ${styles.title}`}>
        <span className={styles.dot} />
        <span className={styles.titleText}>{t('settings.appearance.preview.title')}</span>
      </div>
      <div className={`${glass.glass} ${styles.card}`}>
        <span className={styles.cardTitle}>{t('settings.appearance.preview.card')}</span>
        <span className={styles.cardLine} data-selected="">
          <span>{t('settings.appearance.preview.optionOne')}</span>
          <span className={styles.check} />
        </span>
        <span className={styles.cardLine}>{t('settings.appearance.preview.optionTwo')}</span>
      </div>
      <div className={`${glass.glass} ${styles.controls}`}>
        <span className={styles.play}>
          <Icon path={PLAY} />
        </span>
        <span className={styles.track}>
          <span className={styles.fill} style={{ width: `${(POSITION / DURATION) * 100}%` }} />
        </span>
        <span className={`${styles.time} tabular`}>
          {`${formatTime(POSITION)} / ${formatTime(DURATION)}`}
        </span>
      </div>
    </div>
  );
}
