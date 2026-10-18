/**
 * Which view the shell shows. Apart from `AppShell.tsx` so that what only needs to know the view
 * (the notices decide by it whether the start screen answers for itself) need not load the shell.
 */

import { selectIdle, type PlayerState } from '../state/playerStore';
import type { Page } from '../state/uiStore';

/** What the shell shows. */
export type View = 'home' | 'player' | 'settings';

/**
 * The settings while the user is there; the player while a file is loaded or loading (mpv said it
 * is not idle); else the start screen. Before mpv has said whether it is idle (until the first
 * snapshot) that is the start screen as well, so the player never flashes up at start.
 */
export function selectView(page: Page, { props, loaded }: Pick<PlayerState, 'props' | 'loaded'>): View {
  if (page === 'settings') return 'settings';
  const known = typeof props['idle-active'] === 'boolean';
  return loaded || (known && !selectIdle(props)) ? 'player' : 'home';
}
