import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../i18n';
import type { PluginSettings as PluginSettingsData, SettingSpec } from '../ipc/types';
import PluginSettings from './PluginSettings';
import { usePluginsStore } from './pluginsStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

// --- What Rust says ---------------------------------------------------------------------------

const SCHEMA: SettingSpec[] = [
  {
    key: 'max_height',
    type: 'int',
    default: 200,
    min: 50,
    max: 600,
    label: { en: 'Maximum height', cs: 'Nejvyšší výška' },
  },
  { key: 'prefix', type: 'string', default: 'thumb', label: { en: 'Prefix' } },
  // One of the keys Kaleido sets itself: a schema has none, but a UI must never offer it.
  { key: 'network', type: 'bool', default: false, label: { en: 'Previews of streams' } },
];

const settings = (over: Partial<PluginSettingsData> = {}): PluginSettingsData => ({
  name: 'thumbfast',
  schema: SCHEMA,
  entries: [],
  managed: ['mpv_path', 'network', 'tone_mapping'],
  ...over,
});

/** A plugin that is edited as keys and values. */
const plain = (over: Partial<PluginSettingsData> = {}): PluginSettingsData =>
  settings({ name: 'script.lua', schema: null, managed: [], ...over });

type Answers = Record<string, (args: unknown) => unknown>;

/** The settings `plugins_settings` answers with, and that a change changes (as Rust does). */
let current: PluginSettingsData;

/** Rust's `plugins_set_setting`: sets or takes out the key, and answers with the settings. */
function change(args: unknown): PluginSettingsData {
  const { key, value } = args as { key: string; value: string | null };
  const rest = current.entries.filter((entry) => entry.key !== key);
  current = { ...current, entries: value === null ? rest : [...rest, { key, value }] };
  return current;
}

/** How Rust answers the commands; `answers` replaces some. A throw is a rejection, as Rust's `Err`. */
function rust(answers: Answers = {}) {
  const all: Answers = {
    plugins_settings: () => current,
    plugins_set_setting: change,
    // What the page reads again when a plugin turns out to be gone.
    plugins_list: () => ({ plugins: [], restartNeeded: false, removedEssentials: [], applying: false }),
    ...answers,
  };
  vi.mocked(invoke).mockImplementation((async (command: string, args?: unknown) =>
    all[command]?.(args) ?? null) as unknown as typeof invoke);
}

const sent = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

/** Lets the answers that are on their way arrive, and what they set in motion run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The panel of `name`, once the settings are read. */
async function open(name = 'thumbfast', locked = false) {
  const view = render(<PluginSettings id="panel" name={name} locked={locked} />);
  await settle();
  return view;
}

const panel = (name = 'thumbfast') => screen.getByRole('group', { name: `Settings of ${name}` });
const field = (key: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-setting="${key}"]`);
  if (!found) throw new Error(`no field for ${key}`);
  return found;
};
const text = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const slider = (name: string) => screen.getByRole('slider', { name }) as HTMLInputElement;
const resetOf = (label: string) => screen.getByRole('button', { name: `Reset ${label} to default` });

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  usePluginsStore.setState(usePluginsStore.getInitialState(), true);
  vi.mocked(invoke).mockReset();
  current = settings();
  rust();
  // What Rust refuses is logged, and some tests make it.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  setLanguage('en');
});

describe('opening', () => {
  test('reads the settings, then shows a form for a schema and the editor for none', async () => {
    let answer: (value: PluginSettingsData) => void = () => undefined;
    rust({ plugins_settings: () => new Promise<PluginSettingsData>((resolve) => (answer = resolve)) });
    render(<PluginSettings id="panel" name="thumbfast" />);

    // Named by the plugin; the row's arrow keys leave a group alone (PluginRow).
    expect(panel().getAttribute('aria-busy')).toBe('true');
    expect(panel().id).toBe('panel');
    expect(within(panel()).getByText('Loading…')).toBeTruthy();

    act(() => {
      answer(settings());
    });
    await settle();

    expect(sent('plugins_settings')).toHaveLength(1);
    expect(sent('plugins_settings')[0]?.[1]).toEqual({ name: 'thumbfast' });
    expect(panel().getAttribute('aria-busy')).toBe('false');
    expect(slider('Maximum height')).toBeTruthy();
    expect(within(panel()).queryByRole('group', { name: 'New option' })).toBeNull();
    // Under the form: the changes of a running plugin wait for Apply.
    expect(within(panel()).getByText(/takes effect after Apply/)).toBeTruthy();
  });

  test('a plugin with no schema is edited as keys and values', async () => {
    current = plain({ entries: [{ key: 'max_height', value: '200' }] });
    rust();
    render(<PluginSettings id="panel" name="script.lua" />);
    await settle();

    expect(sent('plugins_settings')[0]?.[1]).toEqual({ name: 'script.lua' });
    expect(text('max_height').value).toBe('200');
    expect(within(panel('script.lua')).getByRole('group', { name: 'New option' })).toBeTruthy();
    expect(document.querySelector('[data-setting]')).toBeNull();
    expect(within(panel('script.lua')).getByText(/takes effect after Apply/)).toBeTruthy();
  });

  test('a read that fails says so, and Try again reads it again', async () => {
    rust({
      plugins_settings: () => {
        throw new Error('the file is locked');
      },
    });
    await open();

    expect(within(panel()).getByRole('alert').textContent).toContain('The settings could not be read.');
    expect(document.querySelector('[data-setting]')).toBeNull();

    rust();
    const retry = within(panel()).getByRole('button', { name: 'Try again' });
    retry.focus();
    fireEvent.click(retry);
    // The button goes with the failure; the focus stays in the panel instead of falling to the page.
    expect(retry.isConnected).toBe(false);
    expect(document.activeElement).toBe(panel());
    await settle();

    expect(sent('plugins_settings')).toHaveLength(2);
    expect(within(panel()).queryByRole('alert')).toBeNull();
    expect(slider('Maximum height')).toBeTruthy();
  });

  test('managed keys never appear', async () => {
    // The schema lists one by mistake, and the file has them: Rust leaves them out of `entries`,
    // and the panel does not rely on that.
    current = settings({
      entries: [
        { key: 'network', value: 'yes' },
        { key: 'mpv_path', value: 'kaleido-mpv.exe' },
        { key: 'prefix', value: 'my' },
      ],
    });
    rust();
    const view = await open();

    expect(field('prefix')).toBeTruthy();
    expect(document.querySelector('[data-setting="network"]')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText('Previews of streams')).toBeNull();
    view.unmount();

    // As keys and values: a managed key in the entries is not a row, and cannot be added.
    current = plain({
      entries: [
        { key: 'mpv_path', value: 'kaleido-mpv.exe' },
        { key: 'custom', value: '1' },
      ],
      managed: ['mpv_path'],
    });
    rust();
    render(<PluginSettings id="panel" name="script.lua" />);
    await settle();

    expect(screen.queryByText('mpv_path')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    fireEvent.change(screen.getByRole('textbox', { name: 'Option name' }), {
      target: { value: 'mpv_path' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add option' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('Kaleido sets this option itself.');
    expect(sent('plugins_set_setting')).toHaveLength(0);
  });
});

describe('changing', () => {
  test('a change is one call, and Rust’s answer is what the form shows', async () => {
    await open();

    fireEvent.change(text('Prefix'), { target: { value: 'my' } });
    fireEvent.keyDown(text('Prefix'), { key: 'Enter' });
    await settle();

    expect(sent('plugins_set_setting')).toHaveLength(1);
    expect(sent('plugins_set_setting')[0]?.[1]).toEqual({
      name: 'thumbfast',
      key: 'prefix',
      value: 'my',
    });
    expect(text('Prefix').value).toBe('my');

    // "Default" sends null, and the schema's default is shown afterwards.
    fireEvent.click(resetOf('Prefix'));
    await settle();

    expect(sent('plugins_set_setting')[1]?.[1]).toEqual({
      name: 'thumbfast',
      key: 'prefix',
      value: null,
    });
    expect(text('Prefix').value).toBe('thumb');
    expect(screen.queryByRole('button', { name: /to default$/ })).toBeNull();
  });

  test('a number goes as text, and a plugin edited as keys and values saves the value as typed', async () => {
    await open();
    fireEvent.change(slider('Maximum height'), { target: { value: '350' } });
    await settle();
    expect(sent('plugins_set_setting')[0]?.[1]).toEqual({
      name: 'thumbfast',
      key: 'max_height',
      value: '350',
    });
    expect(slider('Maximum height').value).toBe('350');

    current = plain({ entries: [{ key: 'fps', value: '30' }] });
    rust();
    render(<PluginSettings id="other" name="script.lua" />);
    await settle();
    fireEvent.change(text('fps'), { target: { value: '60 ' } });
    fireEvent.blur(text('fps'));
    await settle();

    expect(sent('plugins_set_setting')[1]?.[1]).toEqual({
      name: 'script.lua',
      key: 'fps',
      value: '60 ',
    });
    expect(text('fps').value).toBe('60 ');
  });

  test('changes go one after the other, so that the answers come in order', async () => {
    const answers: ((value: PluginSettingsData) => void)[] = [];
    rust({
      plugins_set_setting: () =>
        new Promise<PluginSettingsData>((resolve) => {
          answers.push(resolve);
        }),
    });
    await open();

    fireEvent.change(slider('Maximum height'), { target: { value: '300' } });
    fireEvent.change(text('Prefix'), { target: { value: 'b' } });
    fireEvent.keyDown(text('Prefix'), { key: 'Enter' });
    await settle();

    // The second waits for the first.
    expect(sent('plugins_set_setting')).toHaveLength(1);
    act(() => {
      answers[0]?.(settings({ entries: [{ key: 'max_height', value: '300' }] }));
    });
    await settle();
    expect(sent('plugins_set_setting')).toHaveLength(2);
    expect(sent('plugins_set_setting')[1]?.[1]).toEqual({
      name: 'thumbfast',
      key: 'prefix',
      value: 'b',
    });
    act(() => {
      answers[1]?.(
        settings({
          entries: [
            { key: 'max_height', value: '300' },
            { key: 'prefix', value: 'b' },
          ],
        }),
      );
    });
    await settle();

    expect(slider('Maximum height').value).toBe('300');
    expect(text('Prefix').value).toBe('b');
  });

  test('the value sent stays in its field while Rust writes the file', async () => {
    let answer: (value: PluginSettingsData) => void = () => undefined;
    rust({
      plugins_set_setting: () =>
        new Promise<PluginSettingsData>((resolve) => {
          answer = resolve;
        }),
    });
    await open();

    fireEvent.change(text('Prefix'), { target: { value: 'my' } });
    fireEvent.keyDown(text('Prefix'), { key: 'Enter' });
    await settle();
    // Not the default flashing back.
    expect(text('Prefix').value).toBe('my');

    act(() => {
      answer(settings({ entries: [{ key: 'prefix', value: 'my' }] }));
    });
    await settle();
    expect(text('Prefix').value).toBe('my');
    expect(resetOf('Prefix')).toBeTruthy();
  });

  test('a value that cannot be right never reaches Rust', async () => {
    current = plain({ entries: [{ key: 'fps', value: '30' }] });
    rust();
    render(<PluginSettings id="panel" name="script.lua" />);
    await settle();

    for (const key of ['two words', 'a=b', '', 'fps']) {
      fireEvent.change(screen.getByRole('textbox', { name: 'Option name' }), { target: { value: key } });
      fireEvent.click(screen.getByRole('button', { name: 'Add option' }));
      await settle();
    }

    expect(sent('plugins_set_setting')).toHaveLength(0);
  });
});

describe('what Rust refuses', () => {
  test('an error from Rust shows inline and restores the value', async () => {
    rust({
      plugins_set_setting: () => {
        throw { type: 'invalid', key: 'prefix', reason: 'must be one of: thumb, preview' };
      },
    });
    await open();

    fireEvent.change(text('Prefix'), { target: { value: 'typed' } });
    fireEvent.keyDown(text('Prefix'), { key: 'Enter' });
    await settle();

    const alert = within(field('prefix')).getByRole('alert');
    expect(alert.textContent).toBe(
      'The plugin cannot take this value. Reason: must be one of: thumb, preview',
    );
    // Rust's reason is English whatever the language of the app.
    expect(alert.querySelector('[lang="en"]')?.textContent).toBe('must be one of: thumb, preview');
    expect(text('Prefix').value).toBe('thumb');
    expect(text('Prefix').getAttribute('aria-invalid')).toBe('true');
    expect(console.warn).toHaveBeenCalled();

    // A slider goes back to where it was.
    fireEvent.change(slider('Maximum height'), { target: { value: '350' } });
    await settle();
    expect(slider('Maximum height').value).toBe('200');
    expect(within(field('max_height')).getByRole('alert')).toBeTruthy();

    // The next change that Rust takes takes the message away.
    rust();
    fireEvent.change(text('Prefix'), { target: { value: 'again' } });
    expect(within(field('prefix')).queryByRole('alert')).toBeNull();
    fireEvent.keyDown(text('Prefix'), { key: 'Enter' });
    await settle();
    expect(text('Prefix').value).toBe('again');
    expect(within(field('prefix')).queryByRole('alert')).toBeNull();
  });

  test.each([
    ['is busy', { type: 'busy' }, 'Changes wait until Apply finishes.'],
    [
      'cannot write the file',
      { type: 'io', message: 'cannot write script-opts\\thumbfast.conf: access denied' },
      'cannot write script-opts\\thumbfast.conf: access denied',
    ],
    ['has no player', { type: 'unavailable' }, 'The player is not running or could not be restarted.'],
    ['fails in some other way', new Error('boom'), 'The change could not be made.'],
  ])('a change where Rust %s is said with the sentence of the page', async (_name, error, message) => {
    rust({
      plugins_set_setting: () => {
        throw error;
      },
    });
    await open();

    fireEvent.change(text('Prefix'), { target: { value: 'typed' } });
    fireEvent.keyDown(text('Prefix'), { key: 'Enter' });
    await settle();

    expect(within(field('prefix')).getByRole('alert').textContent).toContain(message);
    expect(text('Prefix').value).toBe('thumb');
  });

  test('a plugin that is gone is said, and the page reads its list again', async () => {
    rust({
      plugins_set_setting: () => {
        throw { type: 'notFound', name: 'thumbfast' };
      },
    });
    await open();
    expect(sent('plugins_list')).toHaveLength(0);

    fireEvent.change(text('Prefix'), { target: { value: 'typed' } });
    fireEvent.keyDown(text('Prefix'), { key: 'Enter' });
    await settle();

    expect(within(field('prefix')).getByRole('alert').textContent).toBe(
      'This plugin is gone. The list was read again.',
    );
    expect(sent('plugins_list')).toHaveLength(1);
  });

  test('an answer that is no settings is a change that was not made', async () => {
    rust({ plugins_set_setting: () => ({ nothing: 'useful' }) });
    await open();

    fireEvent.change(text('Prefix'), { target: { value: 'typed' } });
    fireEvent.keyDown(text('Prefix'), { key: 'Enter' });
    await settle();

    expect(within(field('prefix')).getByRole('alert').textContent).toBe('The change could not be made.');
    expect(text('Prefix').value).toBe('thumb');
  });

  test('the editor says it under the row, and keeps the value as Rust has it', async () => {
    current = plain({ entries: [{ key: 'fps', value: '30' }] });
    rust({
      plugins_set_setting: () => {
        throw { type: 'invalid', key: 'fps', reason: 'a value without line breaks' };
      },
    });
    render(<PluginSettings id="panel" name="script.lua" />);
    await settle();

    fireEvent.change(text('fps'), { target: { value: '60' } });
    fireEvent.blur(text('fps'));
    await settle();

    const item = document.querySelector<HTMLElement>('[data-option="fps"]');
    expect(within(item as HTMLElement).getByRole('alert').textContent).toBe(
      'The plugin cannot take this value. Reason: a value without line breaks',
    );
    expect(text('fps').value).toBe('30');
  });
});

describe('while Apply runs', () => {
  test('the fields are off', async () => {
    await open('thumbfast', true);

    expect(slider('Maximum height').disabled).toBe(true);
    expect(text('Prefix').disabled).toBe(true);
  });
});

describe('the language of the app', () => {
  test('the labels, the hint and the messages follow it', async () => {
    await open();
    act(() => {
      setLanguage('cs');
    });

    expect(screen.getByRole('group', { name: 'Nastavení pluginu thumbfast' })).toBeTruthy();
    expect(slider('Nejvyšší výška')).toBeTruthy();
    expect(screen.getByText(/projeví až po Použít/)).toBeTruthy();
  });
});
