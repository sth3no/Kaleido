/**
 * The subtitle font: an installed family chosen from a list that can be filtered by typing (the
 * list is long). "Default" at the top takes the option out of mpv.conf, which gives mpv's own font
 * back. The font is mpv's to find by name; Rust refuses a name that is not installed.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { systemFonts } from '../../ipc/commands';
import Dropdown from './Dropdown';
import type { FieldProps } from './FieldProps';
import { useRustList } from './useRustList';

export default function FontField(props: FieldProps<string>) {
  const { t } = useTranslation();
  const fonts = useRustList(systemFonts, 'system_fonts');
  const options = useMemo(
    () => [
      { value: '', label: t('settings.fields.font.default') },
      ...(fonts ?? []).map((family) => ({ value: family, label: family })),
    ],
    [fonts, t],
  );

  return (
    <Dropdown
      {...props}
      disabled={props.disabled === true || fonts === null}
      options={options}
      placeholder={t('settings.fields.font.default')}
      filterLabel={t('settings.fields.font.filter')}
      emptyText={t('settings.fields.font.none')}
    />
  );
}
