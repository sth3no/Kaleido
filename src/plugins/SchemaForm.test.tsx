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
    expect(keys).toEqual(['enabled', 'max_height', 'scale', 'timeout', 'prefix', 'mode', 'tint']);
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
