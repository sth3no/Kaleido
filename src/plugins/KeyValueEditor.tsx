/**
 * The settings of a plugin that has no schema (a script the user added, or an essential's own copy):
 * the keys of its `script-opts` file and their values, edited as they are.
 *
 * - A row is the key (read only), the value in a text field, and "Remove". The value is saved when
 *   the field is left or Enter is pressed, Esc drops what was typed (`DraftInput`). An empty value is
 *   a value (`key=`); "Remove" takes the line out of the file (`null`). After the keyboard, the
 *   focus goes from a removed row to the next one, else the one before it, else the new option.
 * - "Add option" is a row of its own, always there: a name and a value. The name is checked here
 *   first (`[A-Za-z0-9_-]+`, not one Kaleido sets itself, not one the file has already; Rust checks
 *   it again) and a bad one is never sent. Enter in the name goes on to the value, Enter in the value
 *   adds. When it is added, the row is empty again.
 * - A key Rust lists that Kaleido would not write (a hand-edited file) is shown as it is, read only,
 *   without "Remove", with a note: the file is the place to change it.
 * - What Rust refuses (`onChange` resolves with the reason) is said under the row, and the stored
 *   value is back in the field. Nothing is optimistic: the rows are the file as Rust last said it.
 *
 * `onChange` saves one key (`PluginSettings` owns the calls to Rust). In the flow of the page, no layer.
 */

import { useId, useRef, useState, type KeyboardEvent, type Ref, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../input/forward';
import type { OptEntry } from '../ipc/types';
import fields from '../settings/fields/Fields.module.css';
import DraftInput from './DraftInput';
import styles from './PluginSettings.module.css';
import pluginStyles from './PluginsPage.module.css';
import SettingMessage from './SettingMessage';
import { hasLineBreak, isValidKey, type SaveSetting, type SettingProblem } from './settingValue';

export interface KeyValueEditorProps {
  entries: readonly OptEntry[];
  /** The keys Kaleido sets itself: none of them can be added. They are never in `entries`. */
  managed?: readonly string[];
  onChange: SaveSetting;
  /** Nothing changes now (Apply runs). */
  disabled?: boolean;
}

export default function KeyValueEditor({
  entries,
  managed = [],
  onChange,
  disabled,
}: KeyValueEditorProps) {
  const { t } = useTranslation();
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const addKey = useRef<HTMLInputElement>(null);

  const remove = async (key: string, byKeyboard: boolean): Promise<SettingProblem | null> => {
    const editable = entries.filter((entry) => isValidKey(entry.key));
    const index = editable.findIndex((entry) => entry.key === key);
    const next = editable[index + 1] ?? editable[index - 1];
    const problem = await onChange(key, null);
    if (problem === null && byKeyboard) {
      (next === undefined ? addKey.current : inputs.current.get(next.key))?.focus();
    }
    return problem;
  };

  return (
    <div className={styles.editor}>
      {entries.length === 0 ? (
        <p className={styles.empty}>{t('plugins.settings.noOptions')}</p>
      ) : (
        <ul className={styles.options} aria-label={t('plugins.settings.optionsLabel')}>
          {entries.map((entry) => (
            <OptionRow
              key={entry.key}
              entry={entry}
              onChange={onChange}
              onRemove={remove}
              register={(element) => {
                if (element) inputs.current.set(entry.key, element);
                else inputs.current.delete(entry.key);
              }}
              disabled={disabled}
            />
          ))}
        </ul>
      )}
      <AddOption
        entries={entries}
        managed={managed}
        onChange={onChange}
        keyRef={addKey}
        disabled={disabled}
      />
    </div>
  );
}

interface OptionRowProps {
  entry: OptEntry;
  onChange: SaveSetting;
  onRemove: (key: string, byKeyboard: boolean) => Promise<SettingProblem | null>;
  /** Hands the value's field to the editor, which puts the focus there when a row goes. */
  register: Ref<HTMLInputElement>;
  disabled?: boolean;
}

function OptionRow({ entry, onChange, onRemove, register, disabled }: OptionRowProps) {
  const { t } = useTranslation();
  const ids = useId();
  const keyId = `${ids}-key`;
  const errorId = `${ids}-error`;
  const [refused, setRefused] = useState<SettingProblem | null>(null);

  const run = async (change: () => Promise<SettingProblem | null>): Promise<void> => {
    setRefused(null);
    const problem = await change();
    setRefused(problem);
  };

  return (
    <li className={styles.option} data-option={entry.key}>
      <code id={keyId} className={styles.optionKey}>
        {entry.key}
      </code>
      {isValidKey(entry.key) ? (
        <>
          <DraftInput
            labelId={keyId}
            value={entry.value}
            describedBy={refused === null ? undefined : errorId}
            invalid={refused !== null}
            disabled={disabled}
            inputRef={register}
            onChange={(text) => {
              void run(() => onChange(entry.key, text));
            }}
            onEdit={() => {
              setRefused(null);
            }}
          />
          <button
            type="button"
            className={pluginStyles.quiet}
            aria-label={t('plugins.settings.removeLabel', { key: entry.key })}
            disabled={disabled}
            onClick={(e) => {
              void run(() => onRemove(entry.key, e.detail === 0));
            }}
            {...blurAfterPointer}
          >
            {t('plugins.settings.remove')}
          </button>
        </>
      ) : (
        <>
          <span className={styles.optionValue}>{entry.value}</span>
          <p className={styles.foreign}>{t('plugins.settings.foreignKey')}</p>
        </>
      )}
      {refused !== null && <SettingMessage id={errorId} problem={refused} />}
    </li>
  );
}

interface AddOptionProps {
  entries: readonly OptEntry[];
  managed: readonly string[];
  onChange: SaveSetting;
  /** The name's field: the editor puts the focus there when the last row goes. */
  keyRef: RefObject<HTMLInputElement | null>;
  disabled?: boolean;
}

function AddOption({ entries, managed, onChange, keyRef, disabled }: AddOptionProps) {
  const { t } = useTranslation();
  const ids = useId();
  const errorId = `${ids}-error`;
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<SettingProblem | null>(null);
  const valueField = useRef<HTMLInputElement>(null);

  /** Why the name will not do, in words; `null` when it will. The caller drops the spaces round it (a key has none). */
  const keyFault = (name: string): string | null => {
    if (!isValidKey(name)) return t('plugins.settings.wants.key');
    if (managed.includes(name)) return t('plugins.settings.managedKey');
    if (entries.some((entry) => entry.key === name)) return t('plugins.settings.keyExists');
    return null;
  };

  const add = async (byKeyboard: boolean): Promise<void> => {
    const name = key.trim();
    const fault =
      keyFault(name) ?? (hasLineBreak(value) ? t('plugins.settings.wants.line') : null);
    setMessage(fault === null ? null : { text: fault });
    if (fault !== null) return;
    const problem = await onChange(name, value);
    setMessage(problem);
    if (problem !== null) return;
    setKey('');
    setValue('');
    if (byKeyboard) keyRef.current?.focus();
  };

  /** Enter in the name goes on to the value, if the name will do. */
  const onKeyKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const fault = keyFault(key.trim());
    setMessage(fault === null ? null : { text: fault });
    if (fault === null) valueField.current?.focus();
  };

  const onValueKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void add(true);
  };

  return (
    <div role="group" aria-label={t('plugins.settings.addLabel')} className={styles.add}>
      <input
        ref={keyRef}
        type="text"
        className={fields.input}
        value={key}
        aria-label={t('plugins.settings.newKey')}
        placeholder={t('plugins.settings.newKey')}
        aria-describedby={message === null ? undefined : errorId}
        aria-invalid={message === null ? undefined : true}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        onChange={(e) => {
          setKey(e.target.value);
          setMessage(null);
        }}
        onKeyDown={onKeyKeyDown}
      />
      <input
        ref={valueField}
        type="text"
        className={fields.input}
        value={value}
        aria-label={t('plugins.settings.newValue')}
        placeholder={t('plugins.settings.newValue')}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        onChange={(e) => {
          setValue(e.target.value);
          setMessage(null);
        }}
        onKeyDown={onValueKeyDown}
      />
      <button
        type="button"
        className={pluginStyles.secondary}
        disabled={disabled}
        onClick={(e) => {
          void add(e.detail === 0);
        }}
        {...blurAfterPointer}
      >
        {t('plugins.settings.add')}
      </button>
      {message !== null && <SettingMessage id={errorId} problem={message} />}
    </div>
  );
}
