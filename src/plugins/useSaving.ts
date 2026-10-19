/**
 * The save of one setting, seen from its field. The value that was sent (`pending`) is what the
 * field shows until the save is over, so that nothing flickers back to the old value while Rust
 * answers, a slider's thumb stays where it was let go, and a second click on a switch toggles from
 * what the first one did. When the save is over, the field shows what Rust stores: the new value if it
 * was taken, the old one (and `refused`, the reason) if it was not.
 *
 * Saves of a field can overlap (a quick second click, a slider moved on); the plugin's saves run in
 * order (`PluginSettings`), and only the newest of them says anything here, so an older one that ends
 * first does not take the newer value from the field, and its answer is not the field's.
 */

import { useRef, useState } from 'react';

import type { SettingProblem } from './settingValue';

export interface Saving {
  /** The value being saved (`null`: the key is being taken out of the file), `null` when nothing is. */
  pending: { value: string | null } | null;
  /** Why Rust did not keep the last value. */
  refused: SettingProblem | null;
  /** Shows `value` until `send` has answered. */
  save: (value: string | null, send: () => Promise<SettingProblem | null>) => Promise<void>;
  /** Takes the message away (the user typed again). */
  forgive: () => void;
}

export function useSaving(): Saving {
  const [pending, setPending] = useState<{ value: string | null } | null>(null);
  const [refused, setRefused] = useState<SettingProblem | null>(null);
  /** Counts the saves; the one that holds the newest number is the one that counts. */
  const newest = useRef(0);

  const save: Saving['save'] = async (value, send) => {
    newest.current += 1;
    const mine = newest.current;
    setPending({ value });
    setRefused(null);
    let problem: SettingProblem | null;
    try {
      problem = await send();
    } finally {
      if (newest.current === mine) setPending(null);
    }
    if (newest.current === mine) setRefused(problem);
  };

  return {
    pending,
    refused,
    save,
    forgive: () => {
      setRefused(null);
    },
  };
}
