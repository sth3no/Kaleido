/**
 * Which view the shell shows. Apart from `AppShell.tsx` so that what only needs to know the view
 * (the notices decide by it whether the start screen answers for itself) need not load the shell.
 */

import { selectIdle, type PlayerState } from '../state/playerStore';
import type { Page } from '../state/uiStore';

/** What the shell shows. */
export type View = 'home' | 'player' | 'plugins' | 'settings';

/**
 * Whether a file is open: loaded, or loading (mpv said it is not idle). Before mpv has said
 * whether it is idle (until the first snapshot) nothing is, so the player never flashes up at
 * start. The player shows it; on another page it is the mini player (surface/useSurfaceLayout.ts).
 */
export function selectVideoOpen({ props, loaded }: Pick<PlayerState, 'props' | 'loaded'>): boolean {
  const known = typeof props['idle-active'] === 'boolean';
  return loaded || (known && !selectIdle(props));
}

/**
 * The settings or My plugins while the user is there; the player while a file is open; else the
 * start screen.
 */
export function selectView(page: Page, state: Pick<PlayerState, 'props' | 'loaded'>): View {
  if (page === 'settings') return 'settings';
  if (page === 'plugins') return 'plugins';
  return selectVideoOpen(state) ? 'player' : 'home';
}
