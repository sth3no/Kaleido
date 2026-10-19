/**
 * The settings of one plugin, under its row on My plugins: a form from the plugin's schema
 * (`SchemaForm`), or, for a plugin without one, its `script-opts` keys and values
 * (`KeyValueEditor`). It is part of the page, in the row (Ruling R46: no popover on a page), a
 * `role="group"` named by the plugin, so the row's arrow keys leave it alone (`PluginRow`).
 *
 * - The settings are read from Rust when the panel opens (`plugins_settings`), so the file is read
 *   as it is now, and a failed read says so and can be tried again.
 * - Every change is one call (`plugins_set_setting`), one after the other, and Rust's answer is the
 *   settings as they are then: the forms show that and nothing else, so a value Rust refused is
 *   back in its field. A refusal is said at the field: `Invalid` as "the plugin cannot take this
 *   value" with Rust's English reason after it, any other as the sentence the page uses for it
 *   (`problemText`). A plugin that is gone is read about again by the page.
 * - Rust keeps the keys it sets itself (`managed`) out of `entries` and the schema has none; they
 *   are filtered out here as well, so that they can never be offered.
 * - A running plugin reads its options when the core starts: the change waits for Apply, and Rust
 *   tells the page (`plugins:changed` with `restartNeeded`, so the apply bar shows). The panel says
 *   so under the form.
 */

import type { TFunction } from 'i18next';
import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { pluginsSettings, pluginsSetSetting } from '../ipc/commands';
import type { PluginSettings as PluginSettingsData } from '../ipc/types';
import KeyValueEditor from './KeyValueEditor';
import styles from './PluginSettings.module.css';
import pluginStyles from './PluginsPage.module.css';
import { usePluginsStore } from './pluginsStore';
import { problemOf, problemText } from './problem';
import SchemaForm from './SchemaForm';
import type { SaveSetting, SettingProblem } from './settingValue';

type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; settings: PluginSettingsData }
  | { status: 'failed' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSettings = (value: unknown): value is PluginSettingsData =>
  isRecord(value) &&
  Array.isArray(value.entries) &&
  Array.isArray(value.managed) &&
  (value.schema === null || Array.isArray(value.schema));

/** Why Rust did not take a value, as the field says it. */
function refusal(error: unknown, t: TFunction): SettingProblem {
  if (isRecord(error) && error.type === 'invalid') {
    const reason = typeof error.reason === 'string' ? error.reason.trim() : '';
    return {
      text: t('plugins.settings.refused'),
      detail: reason === '' ? undefined : reason,
    };
  }
  const problem = problemOf(error);
  // The plugin is gone from the folder: the list on the page is stale.
  if (problem.code === 'notFound') void usePluginsStore.getState().load();
  return { text: problemText(problem, t) };
}

export interface PluginSettingsProps {
  /** The id the row's button points at with `aria-controls`. */
  id: string;
  /** `PluginInfo.name`. */
  name: string;
  /** Apply runs: nothing changes meanwhile. */
  locked?: boolean;
  /** The panel itself, which the row focuses when it was opened with the keyboard. */
  ref?: Ref<HTMLDivElement>;
}

export default function PluginSettings({ id, name, locked = false, ref }: PluginSettingsProps) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  /** The changes in flight: each starts when the one before it is answered, so the answers come in order. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    let current = true;
    pluginsSettings(name).then(
      (settings) => {
        if (!current) return;
        if (isSettings(settings)) setLoaded({ status: 'ready', settings });
        else setLoaded({ status: 'failed' });
      },
      (error: unknown) => {
        console.warn('plugins_settings', error);
        if (problemOf(error).code === 'notFound') void usePluginsStore.getState().load();
        if (current) setLoaded({ status: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [name, attempt]);

  const save: SaveSetting = (key, value) => {
    const run = async (): Promise<SettingProblem | null> => {
      try {
        const settings = await pluginsSetSetting(name, key, value);
        if (!isSettings(settings)) throw new Error('plugins_set_setting did not answer with the settings');
        setLoaded({ status: 'ready', settings });
        return null;
      } catch (error) {
        console.warn(`plugins_set_setting ${name}.${key}`, error);
        return refusal(error, t);
      }
    };
    const done = queue.current.then(run);
    queue.current = done;
    return done;
  };

  // What the forms get: never a key that Kaleido sets itself.
  const shown = useMemo(() => {
    if (loaded.status !== 'ready') return null;
    const { schema, entries, managed } = loaded.settings;
    const hidden = new Set(managed);
    return {
      schema: schema === null ? null : schema.filter((spec) => !hidden.has(spec.key)),
      entries: entries.filter((entry) => !hidden.has(entry.key)),
      managed,
    };
  }, [loaded]);

  return (
    <div
      ref={ref}
      id={id}
      role="group"
      aria-label={t('plugins.settings.label', { name })}
      aria-busy={loaded.status === 'loading'}
      // Focusable by the row, not by Tab.
      tabIndex={-1}
      className={styles.panel}
    >
      {loaded.status === 'loading' && <p className={styles.status}>{t('plugins.settings.loading')}</p>}
      {loaded.status === 'failed' && (
        <div role="alert" className={styles.failure}>
          <p className={styles.status}>{t('plugins.settings.loadFailed')}</p>
          <button
            type="button"
            className={pluginStyles.secondary}
            onClick={() => {
              setLoaded({ status: 'loading' });
              setAttempt((count) => count + 1);
            }}
          >
            {t('plugins.retry')}
          </button>
        </div>
      )}
      {shown !== null && (
        <>
          {shown.schema === null ? (
            <KeyValueEditor
              entries={shown.entries}
              managed={shown.managed}
              onChange={save}
              disabled={locked}
            />
          ) : (
            <SchemaForm
              schema={shown.schema}
              entries={shown.entries}
              onChange={save}
              disabled={locked}
            />
          )}
          <p className={styles.applyHint}>{t('plugins.settings.applyHint')}</p>
        </>
      )}
    </div>
  );
}
