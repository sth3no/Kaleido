/**
 * The settings as Rust last confirmed them, for the page: the mpv options (`settings_get_mpv`) and
 * Kaleido's own (`settings_get`, then `settings:changed`). A field shows what is in here, with the
 * value the user is saving standing in until Rust has answered (`useSetting`); the write itself is
 * `useSetting`'s, which puts the confirmed value back in here.
 */

import { create } from 'zustand';

import { settingsGet, settingsGetMpv } from '../ipc/commands';
import type { Settings } from '../ipc/types';

export type SettingsStatus = 'idle' | 'loading' | 'ready' | 'failed';

export type MpvValues = Readonly<Record<string, string | null>>;

export interface SettingsData {
  status: SettingsStatus;
  /** Every mpv option the settings manage; a key Rust had no value for is not here. */
  mpv: MpvValues;
  /** Kaleido's settings, `null` until they are read. */
  kaleido: Settings | null;
  /** Counts the settings Rust has pushed, so that a read that began earlier does not undo one. */
  kaleidoVersion: number;
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
  kaleido: null,
  kaleidoVersion: 0,
  load: async () => {
    // A page opened again shows what it has while it reads.
    if (get().status !== 'ready') set({ status: 'loading' });
    const version = get().kaleidoVersion;
    try {
      const [mpv, kaleido] = await Promise.all([settingsGetMpv(), settingsGet()]);
      if (!isRecord(kaleido)) throw new Error('settings_get did not answer with the settings');
      set((state) => ({
        status: 'ready',
        // Rust answers an empty map while the player is not up yet; the fields show their fallbacks.
        mpv: isRecord(mpv) ? (mpv as MpvValues) : {},
        kaleido: state.kaleidoVersion === version ? kaleido : state.kaleido,
      }));
    } catch (error) {
      console.warn('cannot read the settings', error);
      if (get().status !== 'ready') set({ status: 'failed' });
    }
  },
  setKaleido: (kaleido) => {
    set((state) => ({ kaleido, kaleidoVersion: state.kaleidoVersion + 1 }));
  },
  setMpv: (key, value) => {
    set((state) => ({ mpv: { ...state.mpv, [key]: value } }));
  },
}));
