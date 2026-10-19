/**
 * What the card of a plugin that reports errors does (spec 10.4): "Disable" turns the plugin off,
 * "My plugins" goes to the page. Nothing is turned off by itself; these are the user's words.
 *
 * Turning off is the page's own command (`plugins_set_enabled`). A plugin that runs keeps running
 * until Apply, which the card says once it is off. The state Rust answers with is given to the
 * plugins store too, so that the page shows it as soon as it opens (and straight away where it is
 * already up).
 */

import { pluginsSetEnabled } from '../../ipc/commands';
import { usePluginsStore } from '../../plugins/pluginsStore';
import { problemOf } from '../../plugins/problem';
import { useNoticeStore } from '../../state/noticeStore';
import { useUiStore } from '../../state/uiStore';

/**
 * Turns the plugin `name` off for the card `id`: the card is busy meanwhile, then says it is off,
 * or why it could not be. Resolves when the card has its answer. A second call while it runs does
 * nothing.
 */
export async function disableFromNotice(id: number, name: string): Promise<void> {
  const notices = useNoticeStore.getState();
  const card = notices.notices.find((notice) => notice.id === id);
  if (card?.kind !== 'plugin' || card.phase === 'working') return;
  notices.setPluginPhase(id, 'working');
  try {
    usePluginsStore.getState().setState(await pluginsSetEnabled(name, false));
    useNoticeStore.getState().setPluginPhase(id, 'off');
  } catch (error) {
    console.warn(`cannot turn off ${name}`, error);
    const problem = problemOf(error);
    useNoticeStore.getState().setPluginPhase(id, 'failed', problem);
    // The plugin is gone: the page reads the list again when it opens.
    if (problem.code === 'notFound') void usePluginsStore.getState().load();
  }
}

/** The link of the card: to My plugins. */
export function openPlugins(): void {
  useUiStore.getState().setPage('plugins');
}
