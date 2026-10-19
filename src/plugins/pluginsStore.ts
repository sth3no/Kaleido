/**
 * The plugins as Rust last said them, for My plugins (`PluginsPage`) and for what acts on a plugin
 * from outside the page (the card of a plugin that reports errors).
 *
 * `state` is what `plugins_list` returned, then what every change returned and `plugins:changed`
 * carried; `listenToPlugins` follows the event for as long as the page is up. A read can be
 * overtaken: the page reads when it opens, and a change or an event can come while the read is on
 * its way. What came after the read began is newer than the read, so the read does not replace it
 * (`version`).
 *
 * The actions are Rust's commands, one at a time per plugin (`busy` holds the names whose action
 * runs). Rust is the one who says no: a change while Apply runs is `busy`, and the store does not
 * second-guess it; the page only keeps the controls off meanwhile. What Rust refuses is kept for
 * the row it concerns (`error`), for the apply bar (`applyProblem`) and for the restore button
 * (`restoreProblem`), until the next action of that kind or the page is left (`leave`).
 *
 * "Apply" restarts the player's core. `applyPending` is true from the click until the call has
 * returned, which is after the new core plays on: Rust's `applying` is true for the same time, but
 * the call can be on its way before the first `plugins:changed` is here, and a second click must
 * not start another. The page's controls are off while either is true.
 */

import { create } from 'zustand';

import {
  pluginsApply,
  pluginsList,
  pluginsRestoreEssentials,
  pluginsSetEnabled,
  pluginsUninstall,
} from '../ipc/commands';
import { onPluginsChanged } from '../ipc/events';
import { listenTo } from '../ipc/listen';
import type { PluginsState } from '../ipc/types';
import { problemOf, type PluginProblem } from './problem';

/** What Rust refused to do with the plugin `name`. */
export interface RowError extends PluginProblem {
  name: string;
}

/**
 * What "Restore essentials" did, by name: the essentials that are installed again, and the ones
 * that are not. The ones that are not are the essentials a script of the user's own of the same
 * name is in the way of: Rust drops the stale record and leaves the file alone, so the essential
 * is neither in the list nor offered any more.
 */
export interface RestoreReport {
  back: readonly string[];
  blocked: readonly string[];
}

export interface PluginsData {
  /** `null` until the first read has answered. */
  state: PluginsState | null;
  /** The first read failed, and no state has come since. */
  loadFailed: boolean;
  /** The plugins (`PluginInfo.name`) whose switch or uninstall is on its way. */
  busy: ReadonlySet<string>;
  /** The last refusal of a change of one plugin. */
  error: RowError | null;
  /** The Apply call has not returned yet. */
  applyPending: boolean;
  applyProblem: PluginProblem | null;
  /** The Restore call has not returned yet. */
  restoring: boolean;
  restoreProblem: PluginProblem | null;
  restored: RestoreReport | null;
  /** Counts the states that came, so that a read that began earlier does not undo one. */
  version: number;
  load: () => Promise<void>;
  /** A state came: `plugins:changed`, or the answer of a command. */
  setState: (state: PluginsState) => void;
  setEnabled: (name: string, on: boolean) => Promise<void>;
  /** Moves the plugin to the Recycle Bin; says whether it happened. */
  uninstall: (name: string) => Promise<boolean>;
  restoreEssentials: () => Promise<void>;
  apply: () => Promise<void>;
  /** The page is left: what it said about its last actions goes with it. */
  leave: () => void;
}

/** The essentials of `before` that came back in `after`, and the ones that did not. */
export function restoreReport(before: readonly string[], after: PluginsState): RestoreReport | null {
  const installed = new Set(
    after.plugins.filter((plugin) => plugin.source === 'bundled').map((plugin) => plugin.name),
  );
  const back = before.filter((name) => installed.has(name));
  // Not listed, and not offered either: the user's own script is in the way.
  const blocked = before.filter(
    (name) => !installed.has(name) && !after.removedEssentials.includes(name),
  );
  return back.length === 0 && blocked.length === 0 ? null : { back, blocked };
}

const isState = (value: unknown): value is PluginsState =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as Partial<PluginsState>).plugins);

const withName = (names: ReadonlySet<string>, name: string): ReadonlySet<string> =>
  new Set(names).add(name);

const withoutName = (names: ReadonlySet<string>, name: string): ReadonlySet<string> => {
  const rest = new Set(names);
  rest.delete(name);
  return rest;
};

/** "Changes wait until Apply finishes" stops being true when Apply has finished. */
const unlessBusy = <T extends PluginProblem | null>(problem: T, applying: boolean): T | null =>
  problem?.code === 'busy' && !applying ? null : problem;

export const usePluginsStore = create<PluginsData>()((set, get) => {
  /** Rust refused a change of the plugin `name`: its row says so. A plugin that is gone is read about again. */
  const refuse = (name: string, error: unknown): void => {
    console.warn(`plugins change of ${name}`, error);
    const problem = problemOf(error);
    set({ error: { name, ...problem } });
    if (problem.code === 'notFound') void get().load();
  };

  return {
    state: null,
    loadFailed: false,
    busy: new Set(),
    error: null,
    applyPending: false,
    applyProblem: null,
    restoring: false,
    restoreProblem: null,
    restored: null,
    version: 0,

    load: async () => {
      const version = get().version;
      try {
        const state = await pluginsList();
        if (!isState(state)) throw new Error('plugins_list did not answer with the plugins');
        // A state that came meanwhile is newer than this read.
        if (get().version === version) get().setState(state);
      } catch (error) {
        console.warn('cannot read the plugins', error);
        if (get().state === null) set({ loadFailed: true });
      }
    },

    setState: (state) => {
      set((data) => ({
        state,
        loadFailed: false,
        version: data.version + 1,
        error: unlessBusy(data.error, state.applying),
        restoreProblem: unlessBusy(data.restoreProblem, state.applying),
      }));
    },

    setEnabled: async (name, on) => {
      if (get().busy.has(name)) return;
      set((data) => ({ busy: withName(data.busy, name), error: null }));
      try {
        get().setState(await pluginsSetEnabled(name, on));
      } catch (error) {
        refuse(name, error);
      } finally {
        set((data) => ({ busy: withoutName(data.busy, name) }));
      }
    },

    uninstall: async (name) => {
      if (get().busy.has(name)) return false;
      set((data) => ({ busy: withName(data.busy, name), error: null }));
      try {
        get().setState(await pluginsUninstall(name));
        return true;
      } catch (error) {
        refuse(name, error);
        return false;
      } finally {
        set((data) => ({ busy: withoutName(data.busy, name) }));
      }
    },

    restoreEssentials: async () => {
      if (get().restoring) return;
      const before = get().state?.removedEssentials ?? [];
      set({ restoring: true, restoreProblem: null, restored: null });
      try {
        const state = await pluginsRestoreEssentials();
        get().setState(state);
        set({ restored: restoreReport(before, state) });
      } catch (error) {
        console.warn('plugins_restore_essentials', error);
        const problem = problemOf(error);
        set({ restoreProblem: problem });
        if (problem.code === 'notFound') void get().load();
      } finally {
        set({ restoring: false });
      }
    },

    apply: async () => {
      if (get().applyPending || get().state?.applying) return;
      set({ applyPending: true, applyProblem: null });
      try {
        get().setState(await pluginsApply());
      } catch (error) {
        console.warn('plugins_apply', error);
        const problem = problemOf(error);
        // Another Apply is running: it ends with its own state, and there is nothing to say.
        if (problem.code !== 'busy') set({ applyProblem: problem });
        // The changes still wait, and `applying` ended: what the page shows is Rust's word.
        void get().load();
      } finally {
        set({ applyPending: false });
      }
    },

    leave: () => {
      set({ error: null, applyProblem: null, restoreProblem: null, restored: null });
    },
  };
});

/**
 * Follows `plugins:changed` (a change, Apply starting and ending, a plugin's count of errors) for
 * as long as the page is up; returns what stops it. Start it before `load`, so that a change in
 * between is not lost.
 */
export function listenToPlugins(): () => void {
  return listenTo(
    onPluginsChanged,
    (state) => {
      usePluginsStore.getState().setState(state);
    },
    'plugins:changed',
  );
}
