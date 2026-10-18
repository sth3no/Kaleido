/**
 * The value of one setting and how to change it. A change is saved at once (spec 8.10): the field
 * shows the new value while Rust answers, and when Rust refuses it the field goes back to the value
 * it had and says why, next to itself (`error` is the text's key). Only what changed is sent: an mpv
 * option as `key, value`, one of Kaleido's settings as a patch with that one path in it.
 */

import { useCallback, useRef, useState } from 'react';

import { settingsSet, settingsSetMpv } from '../ipc/commands';
import type { SettingsError } from '../ipc/types';
import {
  getPath,
  isMpvTarget,
  patchFor,
  type FieldKind,
  type SettingDescriptor,
} from './descriptors';
import { isLoaded, useSettingsStore, useSourcesLoaded } from './store';
import { decodeKaleido, decodeMpv, encodeMpv, type FieldValue } from './values';

const ERROR_TYPES = ['notAllowed', 'invalid', 'io', 'unavailable'];

/** Whether `reason` is what Rust rejects a settings command with, as opposed to a plain message. */
export function isSettingsError(reason: unknown): reason is SettingsError {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    'type' in reason &&
    typeof reason.type === 'string' &&
    ERROR_TYPES.includes(reason.type)
  );
}

/** The text that says what is wrong with a value of this kind of field. */
const INVALID_TEXT: Partial<Record<FieldKind['kind'], string>> = {
  langList: 'settings.errors.invalidLangList',
  color: 'settings.errors.invalidColor',
};

/** The key of the text that tells the user why a setting was not saved. */
export function errorText(field: FieldKind, reason: unknown): string {
  if (!isSettingsError(reason)) return 'settings.errors.generic';
  switch (reason.type) {
    case 'invalid':
      // A colour with no alpha (the accent, the glass tint) is told in the words of that colour.
      if (field.kind === 'accent' || (field.kind === 'color' && field.alpha === false)) {
        return 'settings.errors.invalidColorOpaque';
      }
      return INVALID_TEXT[field.kind] ?? 'settings.errors.invalid';
    case 'notAllowed':
      return 'settings.errors.notAllowed';
    case 'io':
      return 'settings.errors.io';
    case 'unavailable':
      return 'settings.errors.unavailable';
  }
}

/**
 * Saves `value` for the setting and puts what Rust confirmed into the store, if `accept` says it is
 * still the newest answer to put there (an older change that is answered late must not leave the
 * store older than what Rust has). Rejects with Rust's error.
 */
async function write(
  descriptor: SettingDescriptor,
  value: FieldValue,
  accept: () => boolean,
): Promise<void> {
  const { target, field } = descriptor;
  if (isMpvTarget(target)) {
    const encoded = encodeMpv(field, value);
    await settingsSetMpv(target.mpv, encoded);
    if (accept()) useSettingsStore.getState().setMpv(target.mpv, encoded);
  } else {
    // The patch holds this one setting; the answer is the settings as they are now.
    const settings = await settingsSet(patchFor(target.kaleido, value));
    if (accept()) useSettingsStore.getState().setKaleido(settings);
  }
}

export interface SettingControl {
  /** What the field shows: the value being saved, else the stored one. */
  value: FieldValue;
  /** The settings have been read; before that the fields are not for changing. */
  ready: boolean;
  /** The key of the text that says why the last change was refused; `null` if it was not. */
  error: string | null;
  save: (value: FieldValue) => void;
  /**
   * The field has a value it will not send (a colour that is no colour): says why, with the key of
   * the text, or takes the message away (`null`). The next `save` takes it away as well.
   */
  reject: (text: string | null) => void;
}

export function useSetting(descriptor: SettingDescriptor): SettingControl {
  const { target, field } = descriptor;
  const stored = useSettingsStore((state) =>
    isMpvTarget(target)
      ? state.mpv[target.mpv]
      : getPath(state.kaleido, target.kaleido),
  );
  // Not for changing before its own source has answered (an mpv option waits for the player). The
  // page does not draw the row before that (`SettingsList`).
  const ready = isLoaded(useSourcesLoaded(), target);
  /** The value being saved: shown in place of the stored one until Rust has answered. */
  const [pending, setPending] = useState<{ value: FieldValue } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The newest change; the answer to an older one no longer decides what is shown. */
  const latest = useRef(0);
  /** The newest change whose answer went into the store. */
  const applied = useRef(0);

  const reject = useCallback((text: string | null) => {
    setError(text);
  }, []);

  const save = useCallback(
    (value: FieldValue) => {
      latest.current += 1;
      const turn = latest.current;
      setPending({ value });
      setError(null);
      const accept = () => {
        if (turn < applied.current) return false;
        applied.current = turn;
        return true;
      };
      write(descriptor, value, accept).then(
        () => {
          if (turn === latest.current) setPending(null);
        },
        (reason: unknown) => {
          console.warn(`cannot save ${descriptor.id}`, reason);
          if (turn !== latest.current) return;
          // Back to the value it had, with the reason next to the field.
          setPending(null);
          setError(errorText(descriptor.field, reason));
        },
      );
    },
    [descriptor],
  );

  const value =
    pending !== null
      ? pending.value
      : isMpvTarget(target)
        ? decodeMpv(field, stored as string | null | undefined)
        : decodeKaleido(field, stored);
  return { value, ready, error, save, reject };
}
