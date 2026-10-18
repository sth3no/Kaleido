/**
 * Appearance (spec 8.5 point 4, 8.10): the language (Ruling R48), the mode, the accent, the glass
 * (tint, opacity, blur, saturation, corner radius), Mica, reduced transparency and the scale of the
 * interface, all rows of settings like the other sections' (`descriptors.ts`), so that the search
 * finds them. Above them, a live preview of three islands over a sample gradient, and "Reset to
 * default", which puts the whole group `appearance` back (`{ appearance: null }`, which Rust takes as
 * the group's defaults; the language is not part of it).
 *
 * Changes show at once: every setting is saved when it is changed, `useAppearance` puts the saved
 * appearance on the app, and the preview is drawn from the settings as they are (the value being
 * saved stands in until Rust has answered) and, for a slider, from the thumb while it is dragged
 * (nothing is saved on the way, `Slider`). The preview never touches the root.
 *
 * Mica is a Windows 11 effect: on Windows 10 (a build below `MICA_MIN_BUILD`) its row is off and
 * says why, and shows it off; the window has the gradient instead (spec 11.1). While the build is not
 * known (not read yet, or Windows would not say) the row is left as it is.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../../input/forward';
import { settingsSet } from '../../ipc/commands';
import type { Appearance as AppearanceSettings } from '../../ipc/types';
import { useUiStore } from '../../state/uiStore';
import { DEFAULT_APPEARANCE, MICA_MIN_BUILD } from '../../theme/tokens';
import { usePrefersDark } from '../../theme/useAppearance';
import type { SectionId } from '../descriptors';
import type { Unavailable } from '../SettingRow';
import { useSettingsStore } from '../store';
import { errorText } from '../useSetting';
import { useSystemAppearance } from '../useSystemAppearance';
import styles from './Appearance.module.css';
import AppearancePreview from './AppearancePreview';
import SettingsList, { type SectionProps } from './SettingsList';

const SECTION: SectionId = 'appearance';
const MICA = 'appearance.mica';

/** The numeric settings a slider can have in the middle of a drag, by the id of their row. */
const SLIDERS = {
  'appearance.glassOpacity': 'glassOpacity',
  'appearance.blur': 'blur',
  'appearance.saturation': 'saturation',
  'appearance.radius': 'radius',
  'appearance.uiScale': 'uiScale',
} as const satisfies Record<string, keyof AppearanceSettings>;

/** The appearance with the values the sliders show now put over the stored ones. */
function withSliders(
  stored: AppearanceSettings,
  shown: Readonly<Record<string, number>>,
): AppearanceSettings {
  const next: AppearanceSettings = { ...stored };
  for (const [id, key] of Object.entries(SLIDERS)) {
    const value = shown[id];
    if (value !== undefined) next[key] = value;
  }
  return next;
}

export default function Appearance({ only }: SectionProps) {
  const { t } = useTranslation();
  const stored = useSettingsStore((state) => state.kaleido?.appearance);
  const system = useSystemAppearance();
  const prefersDark = usePrefersDark();
  const glassOn = useUiStore((state) => state.glass.enabled);
  /** What each slider shows now, by the id of its row. */
  const [shown, setShown] = useState<Readonly<Record<string, number>>>({});
  const [resetting, setResetting] = useState(false);
  /** The key of the text that says why the reset failed. */
  const [resetError, setResetError] = useState<string | null>(null);

  const follow = useCallback((id: string, value: number) => {
    setShown((now) => (now[id] === value ? now : { ...now, [id]: value }));
  }, []);

  const preview = useMemo(() => withSliders(stored ?? DEFAULT_APPEARANCE, shown), [stored, shown]);

  const unavailable = useMemo<Record<string, Unavailable> | undefined>(
    () =>
      system.windowsBuild > 0 && system.windowsBuild < MICA_MIN_BUILD
        ? { [MICA]: { reasonKey: 'settings.items.mica.unavailable', shown: false } }
        : undefined,
    [system.windowsBuild],
  );

  const reset = () => {
    setResetting(true);
    setResetError(null);
    // `null` takes the whole group out of the settings, and Rust gives it its defaults.
    settingsSet({ appearance: null }).then(
      (settings) => {
        useSettingsStore.getState().setKaleido(settings);
        setResetting(false);
      },
      (reason: unknown) => {
        console.warn('cannot reset the appearance', reason);
        setResetError(errorText({ kind: 'toggle' }, reason));
        setResetting(false);
      },
    );
  };

  // The preview and the reset are for the whole section; a search shows the matching rows only.
  const whole = only === undefined && stored !== undefined;

  return (
    <div>
      {whole && (
        <>
          <AppearancePreview
            appearance={preview}
            system={system}
            prefersDark={prefersDark}
            glassOn={glassOn}
          />
          <div className={styles.toolbar}>
            <button
              type="button"
              className={styles.reset}
              disabled={resetting}
              onClick={reset}
              {...blurAfterPointer}
            >
              {t('settings.appearance.reset')}
            </button>
            {resetError !== null && (
              <p role="alert" className={styles.error}>
                {t(resetError)}
              </p>
            )}
          </div>
        </>
      )}
      <SettingsList section={SECTION} only={only} unavailable={unavailable} onPreview={follow} />
    </div>
  );
}
