/**
 * The audio output: one of the devices mpv lists (`audio-device-list`), read when the field shows,
 * named as the system names them. `auto` (mpv's choice) is the first. mpv.conf with no device is
 * `auto`. A list that cannot be read is said under the field, with a button to read it again.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { settingsAudioDevices } from '../../ipc/commands';
import type { AudioDevice } from '../../ipc/types';
import Dropdown from './Dropdown';
import type { FieldProps } from './FieldProps';
import ListError from './ListError';
import { useRustList } from './useRustList';

/** mpv's own choice of output, the device when none is named. */
const AUTO = 'auto';

export default function DeviceField(props: FieldProps<string>) {
  const { t } = useTranslation();
  const { items: devices, failed, retry } = useRustList<AudioDevice>(
    settingsAudioDevices,
    'settings_audio_devices',
  );
  const options = useMemo(
    () =>
      (devices ?? []).map((device) => ({
        value: device.name,
        label: device.description || device.name,
      })),
    [devices],
  );
  const value = props.value === '' ? AUTO : props.value;

  return (
    <>
      <Dropdown
        {...props}
        value={value}
        disabled={props.disabled === true || devices === null}
        options={options}
        emptyText={t('settings.fields.device.none')}
      />
      {failed && <ListError onRetry={retry} />}
    </>
  );
}
