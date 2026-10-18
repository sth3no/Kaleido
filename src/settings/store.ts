/**
 * The settings as Rust last confirmed them, for the page: the mpv options (`settings_get_mpv`) and
 * Kaleido's own (`settings_get`, then `settings:changed`). A field shows what is in here, with the
 * value the user is saving standing in until Rust has answered (`useSetting`); the write itself is
 * `useSetting`'s, which puts the confirmed value back in here.
 *
 * A read can be overtaken: the page reads every time it opens, and the fields can be changed while it
 * is on its way. What Rust confirmed after the read began is newer than the read, so the read does not
 * replace it (`kaleidoVersion` for Kaleido's settings, `mpvStamp` for each mpv option).
 */

import { useMemo } from 'react';
import { create } from 'zustand';

import { settingsGet, settingsGetMpv } from '../ipc/commands';
import type { Settings } from '../ipc/types';
import { isMpvTarget, type SettingTarget } from './descriptors';

export type SettingsStatus = 'idle' | 'loading' | 'ready' | 'failed';

export type MpvValues = Readonly<Record<string, string | null>>;

export interface SettingsData {
  status: SettingsStatus;
  /** Every mpv option the settings manage. */
  mpv: MpvValues;
  /**
   * Whether Rust had values for the mpv options. It answers with an empty map while the player is not
   * up yet; the mpv fields are not for showing or changing then, and the page offers to read again.
   */
  mpvLoaded: boolean;
  /** Kaleido's settings, `null` until they are read. */
  kaleido: Settings | null;
  /** Counts the settings Rust has pushed, so that a read that began earlier does not undo one. */
  kaleidoVersion: number;
  /** Counts the mpv values Rust took. */
  mpvClock: number;
  /** For each mpv option, the `mpvClock` when Rust last took a value for it. */
  mpvStamp: Readonly<Record<string, number>>;
  load: () => Promise<void>;
  /** The settings changed (`settings:changed`, or the answer of `settings_set`). */
  setKaleido: (settings: Settings) => void;
  /** Rust took `value` for `key`. */
  setMpv: (key: string, value: string | null) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const useSettingsStore = create<SettingsData>()((set, get) => ({
  status: 'idle',
  mpv: {},
  mpvLoaded: false,
  kaleido: null,
  kaleidoVersion: 0,
  mpvClock: 0,
  mpvStamp: {},
  load: async () => {
    // A page opened again shows what it has while it reads.
    if (get().status !== 'ready') set({ status: 'loading' });
    const version = get().kaleidoVersion;
    const clock = get().mpvClock;
    try {
      const [mpv, kaleido] = await Promise.all([settingsGetMpv(), settingsGet()]);
      if (!isRecord(kaleido)) throw new Error('settings_get did not answer with the settings');
      const read: Record<string, string | null> = isRecord(mpv) ? { ...(mpv as MpvValues) } : {};
      set((state) => {
        const fresh = { ...read };
        // What Rust took while the read was on its way is newer than what the read saw.
        for (const [key, stamp] of Object.entries(state.mpvStamp)) {
          if (stamp > clock && key in state.mpv) fresh[key] = state.mpv[key] ?? null;
        }
        return {
          status: 'ready',
          mpv: fresh,
          // Rust answers an empty map while the player is not up yet.
          mpvLoaded: Object.keys(read).length > 0,
          kaleido: state.kaleidoVersion === version ? kaleido : state.kaleido,
        };
      });
    } catch (error) {
      console.warn('cannot read the settings', error);
      if (get().status !== 'ready') set({ status: 'failed' });
    }
  },
  setKaleido: (kaleido) => {
    set((state) => ({ kaleido, kaleidoVersion: state.kaleidoVersion + 1 }));
  },
  setMpv: (key, value) => {
    set((state) => {
      const clock = state.mpvClock + 1;
      return {
        mpv: { ...state.mpv, [key]: value },
        mpvClock: clock,
        mpvStamp: { ...state.mpvStamp, [key]: clock },
      };
    });
  },
}));

// --- What can be shown ------------------------------------------------------------------------------

/** Which of the two sources of settings have answered. */
export interface SourcesLoaded {
  /** Rust gave values for the mpv options (`mpvLoaded`). */
  mpv: boolean;
  /** Kaleido's own settings are read. */
  kaleido: boolean;
}

/**
 * The setting's row is for showing once its own source has answered: Kaleido's rows when Kaleido's
 * settings are read, the rows of mpv options when the mpv map has its values. Until then there is no
 * value to show, and a row with a fallback (a slider at its minimum, a list with nothing chosen) would
 * pass for one: the row is not drawn at all, and a field that is not drawn cannot be changed either.
 */
export function useSourcesLoaded(): SourcesLoaded {
  const mpv = useSettingsStore((state) => state.mpvLoaded);
  const kaleido = useSettingsStore((state) => state.kaleido !== null);
  return useMemo(() => ({ mpv, kaleido }), [mpv, kaleido]);
}

/** Whether the source of a setting with this `target` has answered. */
export function isLoaded(sources: SourcesLoaded, target: SettingTarget): boolean {
  return isMpvTarget(target) ? sources.mpv : sources.kaleido;
}
