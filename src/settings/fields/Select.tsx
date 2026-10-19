/**
 * A choice among a few fixed options (hardware decoding, the tone mapping): a dropdown whose
 * options have their texts from the locale files. The list opens in the page (see `Dropdown`).
 *
 * With `customLabelKey` a value that is none of the options (a `ytdl-format` written into mpv.conf by
 * hand) is listed as one more option under that name, chosen; choosing another option replaces it, and
 * then it is gone from the list. Without it such a value is shown as it is, with nothing chosen.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { SelectOption } from '../descriptors';
import Dropdown from './Dropdown';
import type { FieldProps } from './FieldProps';

export interface SelectProps extends FieldProps<string> {
  options: readonly SelectOption[];
  /** The key of the text a value that is none of the options is called. */
  customLabelKey?: string;
}

export default function Select({ options, customLabelKey, ...field }: SelectProps) {
  const { t } = useTranslation();
  const { value } = field;
  // The texts change with the language, not with every render.
  const choices = useMemo(() => {
    const list = options.map((option) => ({ value: option.value, label: t(option.labelKey) }));
    if (customLabelKey !== undefined && value !== '' && !list.some((option) => option.value === value)) {
      list.push({ value, label: t(customLabelKey) });
    }
    return list;
  }, [options, customLabelKey, value, t]);
  return <Dropdown {...field} options={choices} />;
}
