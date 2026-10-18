/**
 * Puts the appearance on the page: the design tokens as CSS variables, `data-theme`,
 * `data-reduce-transparency`, `data-mica` and the UI scale on the root element. It reads the
 * appearance settings (`settings_get`, then `settings:changed`) and Windows' appearance
 * (`system_appearance`, then `system:appearance-changed`) itself, so that it needs no store.
 *
 * It does not control the glass shader: Rust does, by the same rule (`themes::glass_enabled`).
 * The UI only draws the glass opaque when `resolveReduceTransparency` says so, and also when
 * Rust says the glass is off for any other reason (the shader failed, spec 10.6).
 */

import { useEffect, useLayoutEffect, useState } from 'react';

import { settingsGet, systemAppearance } from '../ipc/commands';
import { onSettingsChanged, onSystemAppearanceChanged } from '../ipc/events';
import { listenTo } from '../ipc/listen';
import type { Appearance, SystemAppearance } from '../ipc/types';
import { useUiStore } from '../state/uiStore';
import {
  applyTokens,
  clampUiScale,
  DEFAULT_APPEARANCE,
  DEFAULT_SYSTEM_APPEARANCE,
  effectsAvailable,
  resolveMica,
  resolveReduceTransparency,
  resolveTheme,
  type ResolvedMode,
  type Tokens,
  tokensFromAppearance,
} from './tokens';

/** What the root element shows, worked out from the settings and Windows. */
export interface RootAppearance {
  theme: ResolvedMode;
  /** The glass is drawn opaque, with no `backdrop-filter`. */
  reduceTransparency: boolean;
  /** Mica is behind the window, so the pages paint no background of their own. */
  mica: boolean;
  /** The CSS `zoom` of the page, 0.9 to 1.5. */
  scale: number;
  tokens: Tokens;
}

/**
 * Works out the root's appearance. `glassOn` is Rust's word on the glass (`glass:state`): when it
 * is off for a reason the settings do not show (the shader failed), the glass is opaque as well.
 */
export function resolveRoot(
  appearance: Appearance,
  system: SystemAppearance,
  prefersDark: boolean,
  glassOn = true,
): RootAppearance {
  const theme = resolveTheme(appearance.mode, prefersDark);
  const reduced = resolveReduceTransparency(
    appearance.reduceTransparency,
    effectsAvailable(system),
  );
  return {
    theme,
    reduceTransparency: reduced || !glassOn,
    // Mica is the window's, not the glass': a failed shader leaves it alone.
    mica: resolveMica(appearance, system, reduced),
    scale: clampUiScale(appearance.uiScale),
    tokens: tokensFromAppearance(appearance, theme),
  };
}

function setFlag(root: HTMLElement, name: string, on: boolean): void {
  if (on) root.setAttribute(name, 'true');
  else root.removeAttribute(name);
}

/**
 * Writes the appearance to `root`. The scale is a variable (`--k-ui-scale`), which global.css
 * turns into `zoom`: a transform would break `backdrop-filter` in WebView2 (spec 8.2).
 */
export function applyRoot(root: HTMLElement, state: RootAppearance): void {
  applyTokens(root, state.tokens);
  root.dataset.theme = state.theme;
  setFlag(root, 'data-reduce-transparency', state.reduceTransparency);
  setFlag(root, 'data-mica', state.mica);
  root.style.setProperty('--k-ui-scale', String(state.scale));
}

const DARK_SCHEME = '(prefers-color-scheme: dark)';

/** `null` where the WebView has no media queries (the tests' jsdom). */
const darkQuery = (): MediaQueryList | null =>
  typeof window.matchMedia === 'function' ? window.matchMedia(DARK_SCHEME) : null;

/**
 * Whether the WebView, which follows Windows, wants the dark scheme. Dark where it cannot tell. The
 * settings' preview needs it too, to draw the mode "system" as the root does.
 */
export function usePrefersDark(): boolean {
  const [dark, setDark] = useState(() => darkQuery()?.matches ?? true);
  useEffect(() => {
    const query = darkQuery();
    if (!query) return undefined;
    const update = () => {
      setDark(query.matches);
    };
    update();
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
    };
  }, []);
  return dark;
}

/**
 * Keeps the root element's appearance up to date for as long as the component is mounted. Call it
 * once, in the root of the app. The tokens are on the root before the first paint (a layout
 * effect), with the default settings until the real ones arrive.
 */
export function useAppearance(): void {
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [system, setSystem] = useState<SystemAppearance>(DEFAULT_SYSTEM_APPEARANCE);
  const prefersDark = usePrefersDark();
  const glassOn = useUiStore((state) => state.glass.enabled);

  useEffect(() => {
    let mounted = true;
    // An event that comes while the first read is on its way is newer than that read.
    let heardSettings = false;
    let heardSystem = false;
    const stops = [
      listenTo(
        onSettingsChanged,
        (settings) => {
          heardSettings = true;
          setAppearance(settings.appearance);
        },
        'settings:changed',
      ),
      listenTo(
        onSystemAppearanceChanged,
        (next) => {
          heardSystem = true;
          setSystem(next);
        },
        'system:appearance-changed',
      ),
    ];
    void settingsGet().then(
      (settings) => {
        if (mounted && !heardSettings) setAppearance(settings.appearance);
      },
      (error: unknown) => {
        console.warn('settings_get failed; the default appearance stays', error);
      },
    );
    void systemAppearance().then(
      (next) => {
        if (mounted && !heardSystem) setSystem(next);
      },
      (error: unknown) => {
        console.warn('system_appearance failed; Windows is taken to have effects', error);
      },
    );
    return () => {
      mounted = false;
      for (const stop of stops) stop();
    };
  }, []);

  useLayoutEffect(() => {
    applyRoot(document.documentElement, resolveRoot(appearance, system, prefersDark, glassOn));
  }, [appearance, system, prefersDark, glassOn]);
}
