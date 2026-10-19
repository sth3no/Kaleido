import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../i18n';
import type { OptEntry, SettingSpec } from '../ipc/types';
import SchemaForm from './SchemaForm';
import type { SaveSetting, SettingProblem } from './settingValue';

/** One of each type; two numbers with both bounds (sliders), one with a single bound (a text field). */
const SCHEMA: SettingSpec[] = [
  {
    key: 'enabled',
    type: 'bool',
    default: true,
    label: { en: 'Show previews', cs: 'Zobrazit náhledy' },
  },
  {
    key: 'max_height',
    type: 'int',
    default: 200,
    min: 50,
    max: 600,
    label: { en: 'Maximum height', cs: 'Nejvyšší výška' },
    description: { en: 'The tallest preview, in pixels.', cs: 'Nejvyšší náhled v pixelech.' },
  },
  { key: 'scale', type: 'float', default: 0.5, min: 0, max: 1.5, label: { en: 'Scale' } },
  { key: 'timeout', type: 'int', default: 10, min: 1, label: { en: 'Timeout' } },
  { key: 'prefix', type: 'string', default: 'thumb', label: { en: 'Prefix' } },
  {
    key: 'mode',
    type: 'enum',
    default: 'fast',
    values: ['fast', 'slow'],
    label: { en: 'Mode', cs: 'Režim' },
  },
  { key: 'tint', type: 'color', default: '#FFFFFF', label: { en: 'Tint' } },
  { key: 'ratio', type: 'float', default: 1.5, min: 0.5, label: { en: 'Ratio' } },
];

const entry = (key: string, value: string): OptEntry => ({ key, value });

beforeAll(() => {
  initI18n('en');
});

afterEach(() => {
  setLanguage('en');
});

/** The form over a `onChange` that keeps what it is told, and answers with `answer`. */
function renderForm(entries: OptEntry[] = [], answer: SettingProblem | null = null) {
  const onChange = vi.fn<SaveSetting>(() => Promise.resolve(answer));
  const form = (list: OptEntry[], disabled = false) => (
    <SchemaForm schema={SCHEMA} entries={list} onChange={onChange} disabled={disabled} />
  );
  const view = render(form(entries));
  return {
    onChange,
    show: (list: OptEntry[], disabled = false) => {
      view.rerender(form(list, disabled));
    },
  };
}

/** Lets the answer of `onChange` arrive. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const field = (key: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-setting="${key}"]`);
  if (!found) throw new Error(`no field for ${key}`);
  return found;
};
const slider = (name: string) => screen.getByRole('slider', { name }) as HTMLInputElement;
const text = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const flag = (name: string) => screen.getByRole('switch', { name }) as HTMLButtonElement;
const choice = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const reset = (label: string) =>
  screen.getByRole('button', { name: `Reset ${label} to default` }) as HTMLButtonElement;
const resets = () => screen.queryAllByRole('button', { name: /to default$/ });

describe('the fields', () => {
  test('a schema form uses the field of each type and the Czech label when there is one', () => {
    renderForm();

    // In the schema's order.
    const keys = Array.from(document.querySelectorAll('[data-setting]')).map((row) =>
      row.getAttribute('data-setting'),
    );
    expect(keys).toEqual([
      'enabled',
      'max_height',
      'scale',
      'timeout',
      'prefix',
      'mode',
      'tint',
      'ratio',
    ]);
    // bool: a switch. A number with both bounds: a slider, whole or not. One bound: a text field.
    expect(flag('Show previews')).toBeTruthy();
    expect(slider('Maximum height').min).toBe('50');
    expect(slider('Maximum height').max).toBe('600');
    expect(slider('Maximum height').step).toBe('1');
    expect(slider('Scale').max).toBe('1.5');
    expect(slider('Scale').step).toBe('0.01');
    expect(text('Timeout')).toBeTruthy();
    expect(screen.queryByRole('slider', { name: 'Timeout' })).toBeNull();
    // string: a text field. enum: the list that opens in the page. color: the colour field.
    expect(text('Prefix')).toBeTruthy();
    expect(choice(/^Mode/).getAttribute('aria-haspopup')).toBe('listbox');
    expect(text('Tint')).toBeTruthy();
    expect(screen.getByPlaceholderText('#RRGGBB or #AARRGGBB')).toBe(text('Tint'));
    // No native number field or select: the list and the numbers are the settings page's.
    expect(document.querySelectorAll('input[type="number"], select')).toHaveLength(0);
    // English texts, with the description under the label.
    expect(within(field('max_height')).getByText('The tallest preview, in pixels.')).toBeTruthy();

    act(() => {
      setLanguage('cs');
    });

    expect(flag('Zobrazit náhledy')).toBeTruthy();
    expect(slider('Nejvyšší výška')).toBeTruthy();
    expect(within(field('max_height')).getByText('Nejvyšší náhled v pixelech.')).toBeTruthy();
    expect(choice(/^Režim/)).toBeTruthy();
    // A setting with no Czech text is shown in English.
    expect(slider('Scale')).toBeTruthy();
    expect(text('Prefix')).toBeTruthy();
  });

  test('defaults show until the user sets a value, and Default clears it', async () => {
    const { onChange, show } = renderForm();

    // The file sets nothing: the schema's defaults, and no Default button.
    expect(flag('Show previews').getAttribute('aria-checked')).toBe('true');
    expect(slider('Maximum height').value).toBe('200');
    expect(slider('Scale').value).toBe('0.5');
    expect(text('Timeout').value).toBe('10');
    expect(text('Prefix').value).toBe('thumb');
    expect(choice(/^Mode/).textContent).toBe('fast');
    expect(text('Tint').value).toBe('#FFFFFF');
    expect(resets()).toHaveLength(0);

    // The file sets some of them (and a key the schema does not know, which is no business of the form).
    show([
      entry('enabled', 'no'),
      entry('max_height', '300'),
      entry('scale', '0.25'),
      entry('prefix', 'my'),
      entry('mode', 'slow'),
      entry('tint', '#80000000'),
      entry('unknown', '1'),
    ]);

    expect(flag('Show previews').getAttribute('aria-checked')).toBe('false');
    expect(slider('Maximum height').value).toBe('300');
    expect(slider('Scale').value).toBe('0.25');
    expect(text('Prefix').value).toBe('my');
    expect(choice(/^Mode/).textContent).toBe('slow');
    expect(text('Tint').value).toBe('#80000000');
    // Default only where the file sets the key; the ones it leaves are still the schema's.
    expect(text('Timeout').value).toBe('10');
    expect(resets()).toHaveLength(6);
    expect(within(field('timeout')).queryByRole('button', { name: /to default$/ })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    // Default takes the line out of the file: `null`. After the keyboard the focus stays on the field.
    fireEvent.click(reset('Maximum height'));
    await settle();
    expect(onChange.mock.calls).toEqual([['max_height', null]]);
    expect(document.activeElement).toBe(slider('Maximum height'));

    // Rust answered with the file without the line: the schema's default is back, the button is gone.
    show([
      entry('enabled', 'no'),
      entry('scale', '0.25'),
      entry('prefix', 'my'),
      entry('mode', 'slow'),
      entry('tint', '#80000000'),
    ]);
    expect(slider('Maximum height').value).toBe('200');
    expect(resets()).toHaveLength(5);
    expect(document.activeElement).toBe(slider('Maximum height'));
  });

  test('a value that is not a number or not in the list is shown as the file has it', () => {
    renderForm([entry('max_height', 'lots'), entry('mode', 'turbo'), entry('enabled', 'maybe')]);

    // A slider cannot show text: the default, with the button to take the line out.
    expect(slider('Maximum height').value).toBe('200');
    expect(within(field('max_height')).getByRole('button', { name: /to default$/ })).toBeTruthy();
    // The list shows the value as it is, with nothing chosen.
    expect(choice(/^Mode/).textContent).toBe('turbo');
    // mpv knows yes and no only: anything else is not on.
    expect(flag('Show previews').getAttribute('aria-checked')).toBe('false');
  });
});

describe('saving', () => {
  test('each field saves its value the way Rust reads it, key by key', async () => {
    const { onChange, show } = renderForm();

    // A switch: yes or no, at once.
    fireEvent.click(flag('Show previews'));
    show([entry('enabled', 'no')]);
    fireEvent.click(flag('Show previews'));
    // A slider: the number as text.
    fireEvent.change(slider('Maximum height'), { target: { value: '350' } });
    fireEvent.change(slider('Scale'), { target: { value: '1' } });
    // The list: the chosen value.
    fireEvent.click(choice(/^Mode/));
    fireEvent.click(screen.getByRole('option', { name: 'slow' }));
    // Text fields: when they are left or Enter is pressed. A number is trimmed, a string is not.
    fireEvent.change(text('Timeout'), { target: { value: ' 42 ' } });
    expect(onChange).toHaveBeenCalledTimes(5);
    fireEvent.blur(text('Timeout'));
    fireEvent.change(text('Prefix'), { target: { value: ' new ' } });
    fireEvent.keyDown(text('Prefix'), { key: 'Enter' });
    // A colour is written in capitals, with its #.
    fireEvent.change(text('Tint'), { target: { value: 'ff8800' } });
    fireEvent.blur(text('Tint'));
    await settle();

    expect(onChange.mock.calls).toEqual([
      ['enabled', 'no'],
      ['enabled', 'yes'],
      ['max_height', '350'],
      ['scale', '1'],
      ['mode', 'slow'],
      ['timeout', '42'],
      ['prefix', ' new '],
      ['tint', '#FF8800'],
    ]);
  });

  test('a text field that is left as it was saves nothing, and Esc drops the typing', () => {
    const { onChange } = renderForm([entry('prefix', 'my')]);

    fireEvent.change(text('Prefix'), { target: { value: 'my' } });
    fireEvent.blur(text('Prefix'));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(text('Prefix'), { target: { value: 'other' } });
    // Handled by the field, so mpv does not get the Esc.
    expect(fireEvent.keyDown(text('Prefix'), { key: 'Escape' })).toBe(false);
    expect(text('Prefix').value).toBe('my');
    fireEvent.blur(text('Prefix'));
    expect(onChange).not.toHaveBeenCalled();
  });

  test('clearing a number or a colour is Default, and clearing a string is an empty value', async () => {
    const { onChange } = renderForm([
      entry('timeout', '30'),
      entry('tint', '#112233'),
      entry('prefix', 'my'),
    ]);

    fireEvent.change(text('Timeout'), { target: { value: '' } });
    fireEvent.blur(text('Timeout'));
    fireEvent.change(text('Tint'), { target: { value: '' } });
    fireEvent.blur(text('Tint'));
    fireEvent.change(text('Prefix'), { target: { value: '' } });
    fireEvent.blur(text('Prefix'));
    await settle();

    expect(onChange.mock.calls).toEqual([
      ['timeout', null],
      ['tint', null],
      ['prefix', ''],
    ]);
  });
});

describe('a value that cannot be right', () => {
  test('stays in the field with what the field takes, is never sent, and goes when it is typed over', async () => {
    const { onChange } = renderForm();

    fireEvent.change(text('Timeout'), { target: { value: '0' } });
    fireEvent.blur(text('Timeout'));

    const alert = within(field('timeout')).getByRole('alert');
    expect(alert.textContent).toBe('Use a whole number, 1 or more.');
    expect(text('Timeout').value).toBe('0');
    expect(text('Timeout').getAttribute('aria-invalid')).toBe('true');
    expect(text('Timeout').getAttribute('aria-describedby')).toContain(alert.id);

    // Not a number at all, and a colour that is none.
    fireEvent.change(text('Timeout'), { target: { value: '1.5' } });
    fireEvent.blur(text('Timeout'));
    expect(within(field('timeout')).getByRole('alert').textContent).toBe('Use a whole number, 1 or more.');
    fireEvent.change(text('Tint'), { target: { value: 'purple' } });
    fireEvent.blur(text('Tint'));
    expect(within(field('tint')).getByRole('alert').textContent).toBe('Use #RRGGBB or #AARRGGBB.');
    await settle();
    expect(onChange).not.toHaveBeenCalled();

    // Typing over it takes the message away; so does Esc.
    fireEvent.change(text('Timeout'), { target: { value: '5' } });
    expect(within(field('timeout')).queryByRole('alert')).toBeNull();
    fireEvent.keyDown(text('Tint'), { key: 'Escape' });
    expect(within(field('tint')).queryByRole('alert')).toBeNull();
    expect(text('Tint').value).toBe('#FFFFFF');

    // And a good one goes through.
    fireEvent.blur(text('Timeout'));
    await settle();
    expect(onChange.mock.calls).toEqual([['timeout', '5']]);
  });

  test('is said in the language of the app, numbers included', () => {
    renderForm();
    act(() => {
      setLanguage('cs');
    });

    fireEvent.change(text('Timeout'), { target: { value: '-3' } });
    fireEvent.blur(text('Timeout'));

    expect(within(field('timeout')).getByRole('alert').textContent).toBe('Zadej celé číslo, nejméně 1.');
  });
});

describe('what Rust refuses', () => {
  const REFUSED: SettingProblem = {
    text: 'The plugin cannot take this value.',
    detail: 'must be at most 600',
  };

  test('is said under the field with Rust’s reason, and the stored value is back in it', async () => {
    const { onChange } = renderForm([entry('prefix', 'my')], REFUSED);

    fireEvent.change(text('Prefix'), { target: { value: 'typed' } });
    fireEvent.blur(text('Prefix'));
    await settle();

    expect(onChange.mock.calls).toEqual([['prefix', 'typed']]);
    const alert = within(field('prefix')).getByRole('alert');
    expect(alert.textContent).toBe('The plugin cannot take this value. Reason: must be at most 600');
    // Rust's reason is English whatever the language of the app.
    expect(alert.querySelector('[lang="en"]')?.textContent).toBe('must be at most 600');
    expect(text('Prefix').value).toBe('my');
    expect(text('Prefix').getAttribute('aria-invalid')).toBe('true');
    // Only the field concerned.
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    // Typing again takes it away.
    fireEvent.change(text('Prefix'), { target: { value: 'again' } });
    expect(within(field('prefix')).queryByRole('alert')).toBeNull();
  });

  test('a switch stays as it was, and the next change takes the message away', async () => {
    const { onChange, show } = renderForm([], REFUSED);

    fireEvent.click(flag('Show previews'));
    await settle();

    expect(flag('Show previews').getAttribute('aria-checked')).toBe('true');
    expect(within(field('enabled')).getByRole('alert').textContent).toContain('cannot take this value');

    // The next change is sent, and its answer says what is so now.
    onChange.mockImplementation(() => Promise.resolve(null));
    fireEvent.click(flag('Show previews'));
    await settle();
    show([entry('enabled', 'no')]);
    expect(within(field('enabled')).queryByRole('alert')).toBeNull();
    expect(flag('Show previews').getAttribute('aria-checked')).toBe('false');
  });
});

/** An `onChange` whose answers the test gives, one by one, in the order it was called. */
function slowAnswers(onChange: ReturnType<typeof renderForm>['onChange']) {
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

describe('a value that was sent', () => {
  const REFUSED: SettingProblem = {
    text: 'The plugin cannot take this value.',
    detail: 'must be at most 600',
  };

  test('stays in its text field while Rust answers, then Rust’s answer is shown', async () => {
    const { onChange, show } = renderForm([entry('prefix', 'my')]);
    const answer = slowAnswers(onChange);

    fireEvent.change(text('Prefix'), { target: { value: 'typed' } });
    fireEvent.keyDown(text('Prefix'), { key: 'Enter' });

    // Not the old value: nothing flashes back while Rust writes the file.
    expect(text('Prefix').value).toBe('typed');
    await settle();
    expect(text('Prefix').value).toBe('typed');

    // Rust took it, and its answer is the file with the line.
    answer(0);
    show([entry('prefix', 'typed')]);
    await settle();
    expect(text('Prefix').value).toBe('typed');
    expect(within(field('prefix')).queryByRole('alert')).toBeNull();

    // A value that Rust refuses: shown while it runs, then the stored value is back, with the reason.
    fireEvent.change(text('Prefix'), { target: { value: 'again' } });
    fireEvent.blur(text('Prefix'));
    expect(text('Prefix').value).toBe('again');
    answer(1, REFUSED);
    await settle();
    expect(text('Prefix').value).toBe('typed');
    expect(within(field('prefix')).getByRole('alert').textContent).toContain('cannot take this value');
  });

  test('keeps a slider where it was let go, and puts it back when Rust refuses', async () => {
    const { onChange } = renderForm();
    const answer = slowAnswers(onChange);

    fireEvent.pointerDown(slider('Maximum height'));
    fireEvent.change(slider('Maximum height'), { target: { value: '350' } });
    fireEvent.pointerUp(slider('Maximum height'));

    // Saved once, where the pointer was let go; the thumb does not snap back to 200.
    expect(onChange.mock.calls).toEqual([['max_height', '350']]);
    expect(slider('Maximum height').value).toBe('350');
    expect(slider('Maximum height').getAttribute('aria-valuetext')).toBe('350');
    await settle();
    expect(slider('Maximum height').value).toBe('350');

    answer(0, REFUSED);
    await settle();
    expect(slider('Maximum height').value).toBe('200');
    expect(within(field('max_height')).getByRole('alert')).toBeTruthy();
  });

  test('is what a switch toggles from, so a quick second click is not lost', async () => {
    const { onChange } = renderForm();
    const answer = slowAnswers(onChange);

    fireEvent.click(flag('Show previews'));
    expect(flag('Show previews').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(flag('Show previews'));
    expect(flag('Show previews').getAttribute('aria-checked')).toBe('true');
    // Two changes, each from what the switch showed: off, then on again (not off twice).
    expect(onChange.mock.calls).toEqual([
      ['enabled', 'no'],
      ['enabled', 'yes'],
    ]);

    // The older answer ends first and takes nothing from the newer value.
    answer(0);
    await settle();
    expect(flag('Show previews').getAttribute('aria-checked')).toBe('true');
    answer(1);
    await settle();
    expect(flag('Show previews').getAttribute('aria-checked')).toBe('true');
  });

  test('a refusal of an older save is not said while a newer one runs', async () => {
    const { onChange } = renderForm();
    const answer = slowAnswers(onChange);

    fireEvent.click(flag('Show previews'));
    fireEvent.click(flag('Show previews'));
    answer(0, REFUSED);
    await settle();

    expect(within(field('enabled')).queryByRole('alert')).toBeNull();
    answer(1, REFUSED);
    await settle();
    expect(within(field('enabled')).getByRole('alert')).toBeTruthy();
  });

  test('Default shows the schema’s default at once, and the stored value if Rust refuses', async () => {
    const { onChange } = renderForm([entry('prefix', 'my')]);
    const answer = slowAnswers(onChange);

    fireEvent.click(reset('Prefix'));

    expect(text('Prefix').value).toBe('thumb');
    expect(resets()).toHaveLength(0);
    answer(0, REFUSED);
    await settle();
    // Rust refused: the file still has the line.
    expect(text('Prefix').value).toBe('my');
    expect(resets()).toHaveLength(1);
  });
});

describe('a number field', () => {
  test('takes a decimal comma and saves a point; a space or a second separator is refused', async () => {
    const { onChange } = renderForm();

    fireEvent.change(text('Ratio'), { target: { value: '0,75' } });
    fireEvent.blur(text('Ratio'));
    await settle();
    expect(onChange.mock.calls).toEqual([['ratio', '0.75']]);

    for (const typed of ['1 000', '1,000,5', '1.000,5', '0,25']) {
      fireEvent.change(text('Ratio'), { target: { value: typed } });
      fireEvent.blur(text('Ratio'));
      expect(within(field('ratio')).getByRole('alert').textContent, typed).toBe(
        'Use a number, 0.5 or more.',
      );
      expect(text('Ratio').value, typed).toBe(typed);
    }
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('can be typed as the sentence under it writes the bound, in both languages', async () => {
    const { onChange } = renderForm();
    act(() => {
      setLanguage('cs');
    });

    fireEvent.change(text('Ratio'), { target: { value: '0,2' } });
    fireEvent.blur(text('Ratio'));
    const message = within(field('ratio')).getByRole('alert').textContent ?? '';
    expect(message).toBe('Zadej číslo, nejméně 0,5.');

    // The number in the sentence, as written, is accepted.
    const bound = /nejméně (\S+)\./.exec(message)?.[1] ?? '';
    fireEvent.change(text('Ratio'), { target: { value: bound } });
    fireEvent.blur(text('Ratio'));
    await settle();
    expect(onChange.mock.calls).toEqual([['ratio', '0.5']]);

    act(() => {
      setLanguage('en');
    });
    fireEvent.change(text('Ratio'), { target: { value: '0.1' } });
    fireEvent.blur(text('Ratio'));
    const english = within(field('ratio')).getByRole('alert').textContent ?? '';
    expect(english).toBe('Use a number, 0.5 or more.');
    const written = /number, (\S+) or more/.exec(english)?.[1] ?? '';
    fireEvent.change(text('Ratio'), { target: { value: written } });
    fireEvent.blur(text('Ratio'));
    await settle();
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('while Apply runs', () => {
  test('nothing can be changed', () => {
    const { show } = renderForm([entry('prefix', 'my')]);
    show([entry('prefix', 'my')], true);

    expect(flag('Show previews').disabled).toBe(true);
    expect(slider('Maximum height').disabled).toBe(true);
    expect(text('Prefix').disabled).toBe(true);
    expect(text('Tint').disabled).toBe(true);
    expect(choice(/^Mode/).disabled).toBe(true);
    expect(reset('Prefix').disabled).toBe(true);
  });
});
