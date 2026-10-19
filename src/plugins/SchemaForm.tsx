/**
 * The settings of a plugin that has a schema (an essential's manifest, spec 7.2), as a form: one
 * field for each setting, in the schema's order, drawn from its type.
 *
 * - `bool` is a switch, `enum` the in-page list (`Dropdown`, Ruling R46), `color` the colour field,
 *   `string` a text field. A number with both bounds is a slider (a step of 1 for a whole number,
 *   about a hundredth of the range for a float), a number with one bound or none a text field.
 *   Text fields save when they are left or Enter is pressed, the rest at once.
 * - The label and the description are the schema's, Czech where it has Czech text (`localized`).
 * - A setting the file does not set shows the schema's default; "Default" takes the line out of the
 *   file (`null`, the script's default) and shows only while the file sets the key. After the
 *   keyboard the focus goes to the field, which stays when the button goes.
 * - A float is saved as typed (Rust writes it as it is) and a slider's number as `String(number)`.
 *   A cleared number or colour field is the same as "Default". A cleared string is an empty value.
 * - A text that cannot be right (outside the bounds, no colour) is not sent: it stays in the field
 *   and the row says what the field takes. What Rust refuses (`onChange` resolves with the reason)
 *   is said under the field and the stored value is back in it.
 *
 * `onChange` saves one key (`PluginSettings` owns the calls to Rust).
 */

import { useId, useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../input/forward';
import type { OptEntry, SettingSpec } from '../ipc/types';
import ColorField from '../settings/fields/ColorField';
import Dropdown from '../settings/fields/Dropdown';
import Slider from '../settings/fields/Slider';
import Toggle from '../settings/fields/Toggle';
import DraftInput from './DraftInput';
import { localized } from './localized';
import styles from './PluginSettings.module.css';
import SettingMessage from './SettingMessage';
import {
  accepts,
  isOn,
  numberOf,
  stepOf,
  wantsText,
  type SaveSetting,
  type SettingProblem,
} from './settingValue';

export interface SchemaFormProps {
  schema: readonly SettingSpec[];
  /** What the file sets. */
  entries: readonly OptEntry[];
  onChange: SaveSetting;
  /** Nothing changes now (Apply runs). */
  disabled?: boolean;
}

const trimmed = (text: string): string => text.trim();

export default function SchemaForm({ schema, entries, onChange, disabled }: SchemaFormProps) {
  const stored = useMemo(() => new Map(entries.map((entry) => [entry.key, entry.value])), [entries]);

  return (
    <div className={styles.fields}>
      {schema.map((spec) => (
        <SchemaField
          key={spec.key}
          spec={spec}
          stored={stored.get(spec.key)}
          onChange={onChange}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

interface SchemaFieldProps {
  spec: SettingSpec;
  /** The text the file sets, `undefined` where it does not set the key. */
  stored: string | undefined;
  onChange: SaveSetting;
  disabled?: boolean;
}

function SchemaField({ spec, stored, onChange, disabled }: SchemaFieldProps) {
  const { t, i18n } = useTranslation();
  const ids = useId();
  const fieldId = `${ids}-field`;
  const labelId = `${ids}-label`;
  const hintId = `${ids}-hint`;
  const errorId = `${ids}-error`;
  /** The field holds a text it will not send. */
  const [wrong, setWrong] = useState(false);
  /** Why Rust did not keep the last value. */
  const [refused, setRefused] = useState<SettingProblem | null>(null);

  const label = localized(spec.label, i18n.language);
  const description =
    spec.description === undefined ? null : localized(spec.description, i18n.language);

  /** Saves `text`; `null` takes the key out of the file. */
  const commit = async (text: string | null): Promise<void> => {
    // A cleared number or colour is "Default".
    const value =
      text === '' && (spec.type === 'int' || spec.type === 'float' || spec.type === 'color')
        ? null
        : text;
    if (value !== null && !accepts(spec, value)) {
      // The fields do not send these; a slip of theirs must not reach the file.
      setWrong(true);
      return;
    }
    setWrong(false);
    setRefused(null);
    const problem = await onChange(spec.key, value);
    setRefused(problem);
  };

  const edited = () => {
    setWrong(false);
    setRefused(null);
  };

  const message: SettingProblem | null = wrong ? { text: wantsText(spec, t) } : refused;
  const invalid = message !== null;
  const common = {
    id: fieldId,
    labelId,
    describedBy:
      [description === null ? '' : hintId, message === null ? '' : errorId]
        .filter((id) => id !== '')
        .join(' ') || undefined,
    invalid,
    disabled,
  };

  const control = ((): ReactElement => {
    switch (spec.type) {
      case 'bool':
        return (
          <Toggle
            {...common}
            value={isOn(stored, spec.default)}
            onChange={(on) => {
              void commit(on ? 'yes' : 'no');
            }}
          />
        );
      case 'enum':
        return (
          <Dropdown
            {...common}
            value={stored ?? spec.default}
            options={spec.values.map((value) => ({ value, label: value }))}
            onChange={(value) => {
              void commit(value);
            }}
          />
        );
      case 'color':
        return (
          <ColorField
            {...common}
            value={stored ?? spec.default}
            onChange={(text) => {
              void commit(text);
            }}
            onInvalid={(key) => {
              setWrong(key !== null);
            }}
          />
        );
      case 'int':
      case 'float':
        if (spec.min !== undefined && spec.max !== undefined) {
          return (
            <Slider
              {...common}
              value={numberOf(stored, spec.default)}
              min={spec.min}
              max={spec.max}
              step={stepOf(spec.type, spec.min, spec.max)}
              onChange={(number) => {
                void commit(String(number));
              }}
            />
          );
        }
        return (
          <DraftInput
            {...common}
            value={stored ?? String(spec.default)}
            clean={trimmed}
            check={(text) => accepts(spec, text)}
            onChange={(text) => {
              void commit(text);
            }}
            onInvalid={setWrong}
            onEdit={edited}
          />
        );
      case 'string':
        return (
          <DraftInput
            {...common}
            value={stored ?? spec.default}
            onChange={(text) => {
              void commit(text);
            }}
            onEdit={edited}
          />
        );
    }
  })();

  // A switch and a list are buttons: a `<label for>` would leave the button focused after a click.
  const named = spec.type === 'bool' || spec.type === 'enum';

  return (
    <div className={styles.field} data-setting={spec.key}>
      <div className={styles.text}>
        {named ? (
          <span id={labelId} className={styles.label}>
            {label}
          </span>
        ) : (
          <label id={labelId} htmlFor={fieldId} className={styles.label}>
            {label}
          </label>
        )}
        {description !== null && (
          <span id={hintId} className={styles.hint}>
            {description}
          </span>
        )}
      </div>
      <div className={styles.control}>
        <div className={styles.controlLine}>
          {control}
          {stored !== undefined && (
            <button
              type="button"
              className={styles.reset}
              aria-label={t('plugins.settings.defaultLabel', { label })}
              disabled={disabled}
              onClick={(e) => {
                // The button goes with the value; after the keyboard the focus stays on the field.
                if (e.detail === 0) document.getElementById(fieldId)?.focus();
                void commit(null);
              }}
              {...blurAfterPointer}
            >
              {t('plugins.settings.default')}
            </button>
          )}
        </div>
        {message !== null && <SettingMessage id={errorId} problem={message} />}
      </div>
    </div>
  );
}
