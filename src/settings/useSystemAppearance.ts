/**
 * What Windows says about the desktop (`system_appearance`, then `system:appearance-changed`), for
 * the pages of the settings that depend on it: Mica exists from Windows 11 (the build number), and
 * "reduce transparency: automatic" follows the transparency switch. Until Windows has answered it is
 * what the app starts with (effects on, build unknown, so no Mica). An answer that is not an
 * appearance (no Rust behind the call) is left out.
 */

import { useEffect, useState } from 'react';

import { systemAppearance } from '../ipc/commands';
import { onSystemAppearanceChanged } from '../ipc/events';
import { listenTo } from '../ipc/listen';
import type { SystemAppearance } from '../ipc/types';
import { DEFAULT_SYSTEM_APPEARANCE } from '../theme/tokens';

function isSystemAppearance(value: unknown): value is SystemAppearance {
  return (
    typeof value === 'object' &&
    value !== null &&
    'windowsBuild' in value &&
    typeof value.windowsBuild === 'number' &&
    'transparencyEffects' in value &&
    typeof value.transparencyEffects === 'boolean' &&
    'highContrast' in value &&
    typeof value.highContrast === 'boolean'
  );
}

export function useSystemAppearance(): SystemAppearance {
  const [system, setSystem] = useState<SystemAppearance>(DEFAULT_SYSTEM_APPEARANCE);

  useEffect(() => {
    let mounted = true;
    // An event that comes while the first read is on its way is newer than that read.
    let heard = false;
    const stop = listenTo(
      onSystemAppearanceChanged,
      (next) => {
        heard = true;
        setSystem(next);
      },
      'system:appearance-changed',
    );
    void systemAppearance().then(
      (next) => {
        if (mounted && !heard && isSystemAppearance(next)) setSystem(next);
      },
      (error: unknown) => {
        console.warn('system_appearance failed; Windows is taken to have effects but no Mica', error);
      },
    );
    return () => {
      mounted = false;
      stop();
    };
  }, []);

  return system;
}
