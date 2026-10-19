import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../i18n';
import type { OptEntry } from '../ipc/types';
import KeyValueEditor from './KeyValueEditor';
import type { SaveSetting, SettingProblem } from './settingValue';

const entry = (key: string, value: string): OptEntry => ({ key, value });

const ENTRIES = [entry('max_height', '200'), entry('fps-limit', 'x y')];

beforeAll(() => {
  initI18n('en');
});

afterEach(() => {
  setLanguage('en');
});

interface Options {
  /** What `onChange` answers with: the reason, or `null` for saved. */
  answer?: SettingProblem | null;
  managed?: string[];
}

/** The editor over a `onChange` that keeps what it is told. */
function renderEditor(entries: OptEntry[] = ENTRIES, { answer = null, managed = [] }: Options = {}) {
  const onChange = vi.fn<SaveSetting>(() => Promise.resolve(answer));
  const editor = (list: OptEntry[], disabled = false) => (
    <KeyValueEditor entries={list} managed={managed} onChange={onChange} disabled={disabled} />
  );
  const view = render(editor(entries));
  return {
    onChange,
    show: (list: OptEntry[], disabled = false) => {
      view.rerender(editor(list, disabled));
    },
  };
}

/** Lets the answer of `onChange` arrive. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** An `onChange` whose answers the test gives, one by one, in the order it was called. */
function slowAnswers(onChange: ReturnType<typeof renderEditor>['onChange']) {
  const answers: ((problem: SettingProblem | null) => void)[] = [];
  onChange.mockImplementation(
    () =>
      new Promise<SettingProblem | null>((resolve) => {
        answers.push(resolve);
      }),
  );
  return (index: number, problem: SettingProblem | null = null) => {
    act(() => {
      answers[index]?.(problem);
    });
  };
}

const valueOf = (key: string) => screen.getByRole('textbox', { name: key }) as HTMLInputElement;
const removeOf = (key: string) =>
  screen.getByRole('button', { name: `Remove ${key}` }) as HTMLButtonElement;
const row = (key: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-option="${key}"]`);
  if (!found) throw new Error(`no row for ${key}`);
  return found;
};
const newKey = () => screen.getByRole('textbox', { name: 'Option name' }) as HTMLInputElement;
const newValue = () => screen.getByRole('textbox', { name: 'Value' }) as HTMLInputElement;
const addButton = () => screen.getByRole('button', { name: 'Add option' }) as HTMLButtonElement;
const addGroup = () => screen.getByRole('group', { name: 'New option' });

describe('the rows', () => {
  test('a key is read only, its value is a field, and each row can be removed', () => {
    renderEditor();

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(Array.from(document.querySelectorAll('code')).map((key) => key.textContent)).toEqual([
      'max_height',
      'fps-limit',
    ]);
    // The key names its field and is no field itself.
    expect(valueOf('max_height').value).toBe('200');
    expect(valueOf('fps-limit').value).toBe('x y');
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
    expect(removeOf('max_height')).toBeTruthy();
    expect(removeOf('fps-limit')).toBeTruthy();
  });

  test('a file with no options says so, and the new option is there to fill in', () => {
    renderEditor([]);

    expect(screen.getByText('The plugin’s settings file does not set any options yet.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    expect(newKey().value).toBe('');
    expect(newValue().value).toBe('');
  });

  test('the texts follow the language of the app', () => {
    renderEditor();
    act(() => {
      setLanguage('cs');
    });

    expect(screen.getByRole('button', { name: 'Odebrat max_height' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Nová volba' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Přidat volbu' })).toBeTruthy();
  });

  test('a key Kaleido would not write is shown as it is, read only, with a note', () => {
    renderEditor([entry('bad key', 'v'), entry('ok', '1')]);

    const odd = within(row('bad key'));
    expect(odd.getByText('bad key')).toBeTruthy();
    expect(odd.getByText('v')).toBeTruthy();
    expect(odd.getByText('Kaleido cannot change this option. Edit the settings file by hand.')).toBeTruthy();
    expect(odd.queryByRole('textbox')).toBeNull();
    expect(odd.queryByRole('button')).toBeNull();
    // The others are as ever, with no note.
    expect(within(row('ok')).getByRole('textbox')).toBeTruthy();
    expect(within(row('ok')).getByRole('button', { name: 'Remove ok' })).toBeTruthy();
    expect(within(row('ok')).queryByText(/Kaleido cannot change/)).toBeNull();
  });
});

describe('editing a value', () => {
  test('the key-value editor saves on Enter and on blur', async () => {
    const { onChange } = renderEditor();

    // Typing saves nothing.
    fireEvent.change(valueOf('max_height'), { target: { value: '300' } });
    expect(valueOf('max_height').value).toBe('300');
    expect(onChange).not.toHaveBeenCalled();

    // Enter saves, and the key does not go on to anything else.
    expect(fireEvent.keyDown(valueOf('max_height'), { key: 'Enter' })).toBe(false);
    expect(onChange.mock.calls).toEqual([['max_height', '300']]);

    // Leaving the field saves too.
    fireEvent.change(valueOf('fps-limit'), { target: { value: 'z' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.blur(valueOf('fps-limit'));
    expect(onChange.mock.calls).toEqual([
      ['max_height', '300'],
      ['fps-limit', 'z'],
    ]);
    await settle();
  });

  test('a value that is left as it was saves nothing, and Esc drops the typing', () => {
    const { onChange } = renderEditor();

    fireEvent.blur(valueOf('max_height'));
    fireEvent.change(valueOf('max_height'), { target: { value: '999' } });
    // Handled by the field, so that mpv does not get the Esc.
    expect(fireEvent.keyDown(valueOf('max_height'), { key: 'Escape' })).toBe(false);
    expect(valueOf('max_height').value).toBe('200');
    fireEvent.blur(valueOf('max_height'));

    expect(onChange).not.toHaveBeenCalled();
  });

  test('an empty value is a value, and spaces count', async () => {
    const { onChange } = renderEditor();

    fireEvent.change(valueOf('max_height'), { target: { value: '' } });
    fireEvent.blur(valueOf('max_height'));
    fireEvent.change(valueOf('fps-limit'), { target: { value: ' x y ' } });
    fireEvent.blur(valueOf('fps-limit'));
    await settle();

    expect(onChange.mock.calls).toEqual([
      ['max_height', ''],
      ['fps-limit', ' x y '],
    ]);
  });

  test('a value that was sent stays in its field while Rust answers, then the stored one is shown', async () => {
    const { onChange } = renderEditor();
    const answer = slowAnswers(onChange);

    fireEvent.change(valueOf('max_height'), { target: { value: '300' } });
    fireEvent.keyDown(valueOf('max_height'), { key: 'Enter' });

    // Not the old value while Rust writes the file.
    expect(valueOf('max_height').value).toBe('300');
    await settle();
    expect(valueOf('max_height').value).toBe('300');

    // Rust refused it: the stored value is back, with the reason under the row.
    answer(0, { text: 'The plugin cannot take this value.', detail: 'a value without line breaks' });
    await settle();
    expect(valueOf('max_height').value).toBe('200');
    expect(within(row('max_height')).getByRole('alert').textContent).toContain('without line breaks');
  });

  test('a quick second change is shown, and an older answer does not take it away', async () => {
    const { onChange } = renderEditor();
    const answer = slowAnswers(onChange);

    fireEvent.change(valueOf('max_height'), { target: { value: '300' } });
    fireEvent.blur(valueOf('max_height'));
    fireEvent.change(valueOf('max_height'), { target: { value: '400' } });
    fireEvent.blur(valueOf('max_height'));
    expect(onChange.mock.calls).toEqual([
      ['max_height', '300'],
      ['max_height', '400'],
    ]);

    answer(0, { text: 'The plugin cannot take this value.' });
    await settle();
    // The older one was refused, the newer one still runs: its value stays, and nothing is said yet.
    expect(valueOf('max_height').value).toBe('400');
    expect(within(row('max_height')).queryByRole('alert')).toBeNull();
  });
});

describe('Remove', () => {
  test('takes the line out of the file, and the focus goes to the next row', async () => {
    const { onChange } = renderEditor([entry('a', '1'), entry('b', '2'), entry('c', '3')]);

    fireEvent.click(removeOf('b'));
    await settle();

    expect(onChange.mock.calls).toEqual([['b', null]]);
    expect(document.activeElement).toBe(valueOf('c'));
  });

  test('the last row hands the focus to the one before it', async () => {
    renderEditor([entry('a', '1'), entry('b', '2')]);

    fireEvent.click(removeOf('b'));
    await settle();

    expect(document.activeElement).toBe(valueOf('a'));
  });

  test('the only row hands the focus to the new option', async () => {
    const { onChange } = renderEditor([entry('only', '1')]);

    fireEvent.click(removeOf('only'));
    await settle();

    expect(onChange.mock.calls).toEqual([['only', null]]);
    expect(document.activeElement).toBe(newKey());
  });

  test('after the pointer the focus is not moved', async () => {
    renderEditor([entry('a', '1'), entry('b', '2')]);

    fireEvent.click(removeOf('a'), { detail: 1 });
    await settle();

    expect(document.activeElement).toBe(document.body);
  });

  test('a row Rust would not remove says why and stays', async () => {
    renderEditor([entry('a', '1')], {
      answer: { text: 'The plugin cannot take this value.', detail: 'Kaleido sets this option itself' },
    });

    fireEvent.click(removeOf('a'));
    await settle();

    expect(within(row('a')).getByRole('alert').textContent).toContain('Kaleido sets this option itself');
    expect(valueOf('a').value).toBe('1');
    // Not moved on: nothing was removed.
    expect(document.activeElement).toBe(document.body);
  });
});

describe('Add option', () => {
  test('a bad key is refused before it reaches Rust', async () => {
    const { onChange } = renderEditor(ENTRIES, { managed: ['network'] });
    const refusals: [string, string][] = [
      ['', 'Use letters, digits, _ and - for the name of an option.'],
      ['   ', 'Use letters, digits, _ and - for the name of an option.'],
      ['two words', 'Use letters, digits, _ and - for the name of an option.'],
      ['a=b', 'Use letters, digits, _ and - for the name of an option.'],
      ['a.b', 'Use letters, digits, _ and - for the name of an option.'],
      ['#comment', 'Use letters, digits, _ and - for the name of an option.'],
      ['žába', 'Use letters, digits, _ and - for the name of an option.'],
      // Not for the file: Kaleido sets it itself, or it is there already.
      ['network', 'Kaleido sets this option itself.'],
      ['max_height', 'This option is already in the file. Change its value above.'],
    ];

    for (const [key, message] of refusals) {
      fireEvent.change(newKey(), { target: { value: key } });
      fireEvent.change(newValue(), { target: { value: 'v' } });
      fireEvent.click(addButton());
      await settle();
      expect(within(addGroup()).getByRole('alert').textContent, JSON.stringify(key)).toBe(message);
      expect(newKey().getAttribute('aria-invalid')).toBe('true');
    }

    // The fields keep what was typed, so that it can be corrected; typing takes the message away.
    expect(newKey().value).toBe('max_height');
    fireEvent.change(newKey(), { target: { value: 'max_width' } });
    expect(within(addGroup()).queryByRole('alert')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  test('a good key and its value are sent together, and the row is empty again', async () => {
    const { onChange } = renderEditor();

    fireEvent.change(newKey(), { target: { value: ' fps-limit_2 ' } });
    fireEvent.change(newValue(), { target: { value: ' a value ' } });
    fireEvent.click(addButton());
    await settle();

    // The name has no spaces round it (it cannot have any); the value is as typed.
    expect(onChange.mock.calls).toEqual([['fps-limit_2', ' a value ']]);
    expect(newKey().value).toBe('');
    expect(newValue().value).toBe('');
    expect(within(addGroup()).queryByRole('alert')).toBeNull();
    // After the keyboard the focus is ready for the next one.
    expect(document.activeElement).toBe(newKey());
  });

  test('Enter in the name goes on to the value, Enter in the value adds', async () => {
    const { onChange } = renderEditor();

    newKey().focus();
    fireEvent.change(newKey(), { target: { value: 'volume' } });
    // Handled by the field, so that nothing else gets the key.
    expect(fireEvent.keyDown(newKey(), { key: 'Enter' })).toBe(false);
    expect(document.activeElement).toBe(newValue());
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(newValue(), { target: { value: '80' } });
    expect(fireEvent.keyDown(newValue(), { key: 'Enter' })).toBe(false);
    await settle();

    expect(onChange.mock.calls).toEqual([['volume', '80']]);
    expect(document.activeElement).toBe(newKey());
  });

  test('Enter in a bad name says so and stays', () => {
    const { onChange } = renderEditor();

    newKey().focus();
    fireEvent.change(newKey(), { target: { value: 'not ok' } });
    fireEvent.keyDown(newKey(), { key: 'Enter' });

    expect(within(addGroup()).getByRole('alert').textContent).toContain('Use letters, digits');
    expect(document.activeElement).toBe(newKey());
    expect(onChange).not.toHaveBeenCalled();
  });

  test('after the pointer the focus is not moved', async () => {
    renderEditor();

    fireEvent.change(newKey(), { target: { value: 'volume' } });
    fireEvent.click(addButton(), { detail: 1 });
    await settle();

    expect(newKey().value).toBe('');
    expect(document.activeElement).not.toBe(newKey());
  });

  test('what Rust refuses is said under the row, and the fields keep what was typed', async () => {
    const { onChange } = renderEditor(ENTRIES, {
      answer: { text: 'The plugin cannot take this value.', detail: 'a key of letters, digits, _ and -' },
    });

    fireEvent.change(newKey(), { target: { value: 'volume' } });
    fireEvent.change(newValue(), { target: { value: '80' } });
    fireEvent.click(addButton());
    await settle();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(within(addGroup()).getByRole('alert').textContent).toBe(
      'The plugin cannot take this value. Reason: a key of letters, digits, _ and -',
    );
    expect(newKey().value).toBe('volume');
    expect(newValue().value).toBe('80');
  });

  test('Esc drops what is typed in the row first; with nothing typed it is the panel’s', () => {
    const { onChange } = renderEditor();
    newKey().focus();
    fireEvent.change(newKey(), { target: { value: 'volume' } });
    fireEvent.change(newValue(), { target: { value: '80' } });

    // Handled by the row, so that the panel stays open and mpv does not get the Esc.
    expect(fireEvent.keyDown(newKey(), { key: 'Escape' })).toBe(false);
    expect(newKey().value).toBe('');
    expect(newValue().value).toBe('');

    // The same from the value, and for a message with nothing typed.
    fireEvent.change(newValue(), { target: { value: 'x' } });
    expect(fireEvent.keyDown(newValue(), { key: 'Escape' })).toBe(false);
    expect(newValue().value).toBe('');
    fireEvent.click(addButton());
    expect(within(addGroup()).getByRole('alert')).toBeTruthy();
    expect(fireEvent.keyDown(newKey(), { key: 'Escape' })).toBe(false);
    expect(within(addGroup()).queryByRole('alert')).toBeNull();

    // Nothing to drop: left alone, for the panel to close.
    expect(fireEvent.keyDown(newKey(), { key: 'Escape' })).toBe(true);
    expect(fireEvent.keyDown(newValue(), { key: 'Escape' })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('what was typed while Rust answered is not cleared by the answer', async () => {
    const { onChange } = renderEditor();
    const answer = slowAnswers(onChange);

    fireEvent.change(newKey(), { target: { value: 'volume' } });
    fireEvent.change(newValue(), { target: { value: '80' } });
    fireEvent.click(addButton());
    // The user goes on while the call runs.
    fireEvent.change(newKey(), { target: { value: 'volume2' } });
    answer(0);
    await settle();

    expect(onChange.mock.calls).toEqual([['volume', '80']]);
    expect(newKey().value).toBe('volume2');
    expect(newValue().value).toBe('80');
  });

  test('fields that still hold what was sent are cleared by the answer, and a refusal is said', async () => {
    const { onChange } = renderEditor();
    const answer = slowAnswers(onChange);

    fireEvent.change(newKey(), { target: { value: 'volume' } });
    fireEvent.change(newValue(), { target: { value: '80' } });
    fireEvent.click(addButton());
    answer(0);
    await settle();
    expect(newKey().value).toBe('');
    expect(newValue().value).toBe('');

    fireEvent.change(newKey(), { target: { value: 'gain' } });
    fireEvent.click(addButton());
    answer(1, { text: 'The plugin cannot take this value.' });
    await settle();
    expect(newKey().value).toBe('gain');
    expect(within(addGroup()).getByRole('alert')).toBeTruthy();
  });
});

describe('while Apply runs', () => {
  test('nothing can be changed', () => {
    const { show } = renderEditor();
    show(ENTRIES, true);

    expect(valueOf('max_height').disabled).toBe(true);
    expect(removeOf('max_height').disabled).toBe(true);
    expect(newKey().disabled).toBe(true);
    expect(newValue().disabled).toBe(true);
    expect(addButton().disabled).toBe(true);
  });
});
