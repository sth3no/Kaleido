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
import { useSettingsStore } from './store';
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
      return INVALID_TEXT[field.kind] ?? 'settings.errors.invalid';
    case 'notAllowed':
      return 'settings.errors.notAllowed';
    case 'io':
      return 'settings.errors.io';
    case 'unavailable':
      return 'settings.errors.unavailable';
  }
}

/** Saves `value` for the setting and puts what Rust confirmed into the store. Rejects with Rust's error. */
async function write(descriptor: SettingDescriptor, value: FieldValue): Promise<void> {
  const { target, field } = descriptor;
  if (isMpvTarget(target)) {
    const encoded = encodeMpv(field, value);
    await settingsSetMpv(target.mpv, encoded);
    useSettingsStore.getState().setMpv(target.mpv, encoded);
  } else {
    // The patch holds this one setting; the answer is the settings as they are now.
    useSettingsStore.getState().setKaleido(await settingsSet(patchFor(target.kaleido, value)));
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
}

export function useSetting(descriptor: SettingDescriptor): SettingControl {
  const { target, field } = descriptor;
  const stored = useSettingsStore((state) =>
    isMpvTarget(target)
      ? state.mpv[target.mpv]
      : getPath(state.kaleido, target.kaleido),
  );
  const ready = useSettingsStore((state) => state.status === 'ready');
  /** The value being saved: shown in place of the stored one until Rust has answered. */
  const [pending, setPending] = useState<{ value: FieldValue } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The newest change; the answer to an older one no longer decides what is shown. */
  const latest = useRef(0);

  const save = useCallback(
    (value: FieldValue) => {
      latest.current += 1;
      const turn = latest.current;
      setPending({ value });
      setError(null);
      write(descriptor, value).then(
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
  return { value, ready, error, save };
}
