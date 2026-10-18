/**
 * A choice among a few fixed options (hardware decoding, the tone mapping): a dropdown whose
 * options have their texts from the locale files. The list opens in the page (see `Dropdown`).
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { SelectOption } from '../descriptors';
import Dropdown from './Dropdown';
import type { FieldProps } from './FieldProps';

export interface SelectProps extends FieldProps<string> {
  options: readonly SelectOption[];
}

export default function Select({ options, ...field }: SelectProps) {
  const { t } = useTranslation();
  // The texts change with the language, not with every render.
  const choices = useMemo(
    () => options.map((option) => ({ value: option.value, label: t(option.labelKey) })),
    [options, t],
  );
  return <Dropdown {...field} options={choices} />;
}
