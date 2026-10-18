import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../../i18n';
import ColorField from './ColorField';
import DeviceField from './DeviceField';
import Dropdown, { type DropdownProps } from './Dropdown';
import FontField from './FontField';
import LangListField from './LangListField';
import ShaderListField from './ShaderListField';
import Slider, { SAVE_THROTTLE_MS, type SliderProps } from './Slider';
import Toggle from './Toggle';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((() => Promise.resolve(null)) as unknown as typeof invoke);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setLanguage('en');
});

/** How Rust answers a command. */
function rust(answers: Record<string, unknown>) {
  vi.mocked(invoke).mockImplementation(((command: string) =>
    Promise.resolve(answers[command] ?? null)) as unknown as typeof invoke);
}

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

function renderDropdown(props: Partial<DropdownProps> = {}) {
  const onChange = vi.fn();
  const view = render(
    <>
      <span id="label">Letter</span>
      <Dropdown id="field" labelId="label" value="b" onChange={onChange} options={OPTIONS} {...props} />
      <button type="button">Elsewhere</button>
    </>,
  );
  return { onChange, ...view };
}

/** The button that opens the list: named by the label and what is chosen. */
const trigger = () => screen.getByRole('button', { name: /^Letter/ });
const option = (name: string) => screen.getByRole('option', { name });

describe('Dropdown', () => {
  test('opens its list in the page, with the chosen option marked and focused', () => {
    const { container } = renderDropdown();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger().textContent).toBe('Beta');
    expect(trigger().getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger());

    const list = screen.getByRole('listbox', { name: 'Letter' });
    // Part of the page, not a layer of its own: nothing of it can be drawn over the mini player.
    expect(container.contains(list)).toBe(true);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(trigger().getAttribute('aria-controls')).toBe(list.id);
    expect(option('Beta').getAttribute('aria-selected')).toBe('true');
    expect(option('Alpha').getAttribute('aria-selected')).toBe('false');
    // The chosen option is the one Tab reaches, and the list opens on it.
    expect((option('Beta') as HTMLButtonElement).tabIndex).toBe(0);
    expect((option('Alpha') as HTMLButtonElement).tabIndex).toBe(-1);
    expect(document.activeElement).toBe(option('Beta'));
  });

  test('the arrows, Home and End move through the list and are handled, so that mpv does not get them', () => {
    renderDropdown();
    fireEvent.click(trigger());

    expect(fireEvent.keyDown(option('Beta'), { key: 'ArrowDown' })).toBe(false);
    expect(document.activeElement).toBe(option('Gamma'));
    // At the end it stays, and the key is still the list's.
    expect(fireEvent.keyDown(option('Gamma'), { key: 'ArrowDown' })).toBe(false);
    expect(document.activeElement).toBe(option('Gamma'));
    expect(fireEvent.keyDown(option('Gamma'), { key: 'Home' })).toBe(false);
    expect(document.activeElement).toBe(option('Alpha'));
    expect(fireEvent.keyDown(option('Alpha'), { key: 'End' })).toBe(false);
    expect(document.activeElement).toBe(option('Gamma'));
    expect(fireEvent.keyDown(option('Gamma'), { key: 'ArrowUp' })).toBe(false);
    expect(document.activeElement).toBe(option('Beta'));
    // The focus moving chooses nothing, and the list stays open.
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  test('a letter jumps to the next option that starts with it, and never reaches mpv', () => {
    renderDropdown();
    fireEvent.click(trigger());

    expect(fireEvent.keyDown(option('Beta'), { key: 'g' })).toBe(false);
    expect(document.activeElement).toBe(option('Gamma'));
    // Round the end, in any case.
    expect(fireEvent.keyDown(option('Gamma'), { key: 'A' })).toBe(false);
    expect(document.activeElement).toBe(option('Alpha'));
    // No option starts with it: the focus stays, and the key is still the list's (f is mpv's fullscreen).
    expect(fireEvent.keyDown(option('Alpha'), { key: 'z' })).toBe(false);
    expect(document.activeElement).toBe(option('Alpha'));
    // Space is the click on the option, not a letter.
    expect(fireEvent.keyDown(option('Alpha'), { key: ' ' })).toBe(true);
  });

  test('the down arrow on the button opens the list', () => {
    renderDropdown();
    trigger().focus();
    expect(fireEvent.keyDown(trigger(), { key: 'ArrowDown' })).toBe(false);
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(document.activeElement).toBe(option('Beta'));
  });

  test('Esc closes the list, gives the focus back to the button and chooses nothing', () => {
    const { onChange } = renderDropdown();
    // Closed, Esc is not the dropdown's.
    expect(fireEvent.keyDown(trigger(), { key: 'Escape' })).toBe(true);

    fireEvent.click(trigger());
    expect(fireEvent.keyDown(option('Beta'), { key: 'Escape' })).toBe(false);

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(onChange).not.toHaveBeenCalled();
  });

  test('choosing with the keyboard saves it and gives the focus back to the button', () => {
    const { onChange } = renderDropdown();
    fireEvent.click(trigger());
    // Enter and Space on an option click it with no pointer behind the click: detail 0.
    fireEvent.click(option('Gamma'), { detail: 0 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('c');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  test('choosing with the pointer leaves the button without the focus (Space then goes to mpv)', () => {
    const { onChange } = renderDropdown();
    fireEvent.click(trigger());
    fireEvent.click(option('Gamma'), { detail: 1 });

    expect(onChange).toHaveBeenCalledWith('c');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).not.toBe(trigger());
  });

  test('choosing what is chosen already saves nothing', () => {
    const { onChange } = renderDropdown();
    fireEvent.click(trigger());
    fireEvent.click(option('Beta'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('the list closes when the focus leaves the dropdown, not when it moves inside it', () => {
    renderDropdown();
    fireEvent.click(trigger());

    fireEvent.blur(option('Beta'), { relatedTarget: option('Gamma') });
    expect(screen.getByRole('listbox')).toBeTruthy();

    fireEvent.blur(option('Beta'), { relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }) });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('a click on the button while the list is open closes it', () => {
    renderDropdown();
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('a value the list does not have is shown as it is, with nothing chosen', () => {
    renderDropdown({ value: 'zzz' });
    expect(trigger().textContent).toBe('zzz');

    fireEvent.click(trigger());
    for (const each of screen.getAllByRole('option')) {
      expect(each.getAttribute('aria-selected')).toBe('false');
    }
    // The list opens on the first option.
    expect(document.activeElement).toBe(option('Alpha'));
  });

  test('an empty value shows the placeholder', () => {
    renderDropdown({ value: '', placeholder: 'Nothing chosen' });
    expect(trigger().textContent).toBe('Nothing chosen');
  });

  test('a disabled dropdown cannot be opened', () => {
    renderDropdown({ disabled: true });
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
  });

  describe('with a filter', () => {
    const filtered = () => renderDropdown({ filterLabel: 'Filter letters', emptyText: 'No letter matches' });
    const filter = () => screen.getByRole('textbox', { name: 'Filter letters' });

    test('the focus goes to the field, and typing narrows the list down', () => {
      filtered();
      fireEvent.click(trigger());
      expect(document.activeElement).toBe(filter());

      fireEvent.change(filter(), { target: { value: 'GA' } });
      expect(screen.getAllByRole('option').map((each) => each.textContent)).toEqual(['Gamma']);

      fireEvent.change(filter(), { target: { value: 'zzz' } });
      expect(screen.queryAllByRole('option')).toEqual([]);
      expect(screen.getByText('No letter matches')).toBeTruthy();
    });

    test('the down arrow goes on to the list, the up arrow from its first option back to the field', () => {
      filtered();
      fireEvent.click(trigger());
      fireEvent.change(filter(), { target: { value: 'a' } });

      expect(fireEvent.keyDown(filter(), { key: 'ArrowDown' })).toBe(false);
      expect(document.activeElement).toBe(option('Alpha'));
      expect(fireEvent.keyDown(option('Alpha'), { key: 'ArrowUp' })).toBe(false);
      expect(document.activeElement).toBe(filter());
    });

    test('Enter in the field chooses the first match', () => {
      const { onChange } = filtered();
      fireEvent.click(trigger());
      fireEvent.change(filter(), { target: { value: 'ga' } });

      expect(fireEvent.keyDown(filter(), { key: 'Enter' })).toBe(false);

      expect(onChange).toHaveBeenCalledWith('c');
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    test('the text typed is not kept for the next time the list opens', () => {
      filtered();
      fireEvent.click(trigger());
      fireEvent.change(filter(), { target: { value: 'ga' } });
      fireEvent.keyDown(filter(), { key: 'Escape' });

      fireEvent.click(trigger());
      expect((filter() as HTMLInputElement).value).toBe('');
      expect(screen.getAllByRole('option')).toHaveLength(3);
    });
  });
});

describe('Toggle', () => {
  function renderToggle(value: boolean, disabled = false) {
    const onChange = vi.fn();
    render(
      <>
        <span id="label">Remember</span>
        <Toggle id="switch" labelId="label" value={value} onChange={onChange} disabled={disabled} />
      </>,
    );
    return { onChange, toggle: screen.getByRole('switch', { name: 'Remember' }) as HTMLButtonElement };
  }

  test('is a switch named by the label, and a click flips it', () => {
    const { onChange, toggle } = renderToggle(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  test('off turns on', () => {
    const { onChange, toggle } = renderToggle(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  test('is not for changing while the settings are not read', () => {
    const { toggle } = renderToggle(true, true);
    expect(toggle.disabled).toBe(true);
  });
});

describe('Slider', () => {
  function renderSlider(props: Partial<SliderProps> = {}) {
    const onChange = vi.fn();
    const view = render(
      <>
        <span id="label">Level</span>
        <Slider
          id="slider"
          labelId="label"
          value={50}
          onChange={onChange}
          min={0}
          max={100}
          step={1}
          unitKey="settings.units.percent"
          {...props}
        />
      </>,
    );
    return { onChange, ...view, slider: screen.getByRole('slider', { name: 'Level' }) as HTMLInputElement };
  }

  test('shows its value with the unit, and says it to screen readers', () => {
    const { slider } = renderSlider();
    expect(slider.min).toBe('0');
    expect(slider.max).toBe('100');
    expect(slider.getAttribute('aria-valuetext')).toBe('50%');
    expect(screen.getByText('50%').tagName).toBe('OUTPUT');
  });

  test('without a unit the number stands alone, in the number format of the language', () => {
    const { slider } = renderSlider({ unitKey: undefined, min: 100, max: 1000, step: 5, value: 1000 });
    expect(slider.getAttribute('aria-valuetext')).toBe('1,000');
  });

  test('a drag saves nothing on the way and the value where the pointer is let go, once', () => {
    const { onChange, slider } = renderSlider();

    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '60' } });
    fireEvent.change(slider, { target: { value: '70' } });

    // The number follows the thumb.
    expect(slider.getAttribute('aria-valuetext')).toBe('70%');
    expect(onChange).not.toHaveBeenCalled();

    // The pointer may be let go away from the slider.
    fireEvent.pointerUp(document.body);
    expect(onChange.mock.calls).toEqual([[70]]);
  });

  test('a drag that ends where it began saves nothing', () => {
    const { onChange, slider } = renderSlider();
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '90' } });
    fireEvent.change(slider, { target: { value: '50' } });
    fireEvent.pointerUp(slider);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('a pointer that is cancelled ends the drag too', () => {
    const { onChange, slider } = renderSlider();
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '20' } });
    fireEvent.pointerCancel(document.body);
    expect(onChange.mock.calls).toEqual([[20]]);
  });

  test('keyboard steps save at once, and the last one when the key is let go', () => {
    const { onChange, slider } = renderSlider();

    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.change(slider, { target: { value: '51' } });
    // The first step went at once.
    expect(onChange.mock.calls).toEqual([[51]]);
    // The key repeats within the throttle's interval: held back.
    fireEvent.change(slider, { target: { value: '52' } });
    fireEvent.change(slider, { target: { value: '53' } });
    expect(onChange.mock.calls).toEqual([[51]]);

    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(onChange.mock.calls).toEqual([[51], [53]]);
  });

  test('a key held down saves at most once every throttle interval', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { onChange, slider } = renderSlider();

    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.change(slider, { target: { value: '51' } });
    fireEvent.change(slider, { target: { value: '52' } });
    fireEvent.change(slider, { target: { value: '53' } });
    act(() => {
      vi.advanceTimersByTime(SAVE_THROTTLE_MS - 1);
    });
    expect(onChange.mock.calls).toEqual([[51]]);

    // The newest step goes when the interval is over.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onChange.mock.calls).toEqual([[51], [53]]);

    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(onChange.mock.calls).toEqual([[51], [53]]);
  });

  test('a value set by neither the pointer nor a key (a screen reader) is saved at once', () => {
    const { onChange, slider } = renderSlider();
    fireEvent.change(slider, { target: { value: '80' } });
    expect(onChange.mock.calls).toEqual([[80]]);
  });

  test('a value is held to the range and to the step', () => {
    const { onChange, slider } = renderSlider({
      min: 0,
      max: 10,
      step: 0.5,
      value: 3,
      unitKey: undefined,
    });
    fireEvent.change(slider, { target: { value: '2.5' } });
    expect(onChange.mock.calls).toEqual([[2.5]]);
    expect(slider.getAttribute('aria-valuetext')).toBe('3');
  });

  test('what was held back is saved when the slider goes away', () => {
    const { onChange, slider, unmount } = renderSlider();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.change(slider, { target: { value: '51' } });
    fireEvent.change(slider, { target: { value: '52' } });
    expect(onChange.mock.calls).toEqual([[51]]);

    unmount();
    expect(onChange.mock.calls).toEqual([[51], [52]]);
  });

  test('a value that comes from outside shows when nothing is moving it', () => {
    const { slider, rerender } = renderSlider();
    rerender(
      <>
        <span id="label">Level</span>
        <Slider
          id="slider"
          labelId="label"
          value={20}
          onChange={() => undefined}
          min={0}
          max={100}
          step={1}
          unitKey="settings.units.percent"
        />
      </>,
    );
    expect(slider.getAttribute('aria-valuetext')).toBe('20%');
    expect(slider.value).toBe('20');
  });
});

describe('ColorField', () => {
  function renderColor(value = '#FFFFFFFF') {
    const onChange = vi.fn();
    const onInvalid = vi.fn();
    const view = render(
      <>
        <span id="label">Colour</span>
        <ColorField
          id="color"
          labelId="label"
          value={value}
          onChange={onChange}
          onInvalid={onInvalid}
        />
      </>,
    );
    return {
      onChange,
      onInvalid,
      ...view,
      field: screen.getByRole('textbox', { name: 'Colour' }) as HTMLInputElement,
    };
  }

  test('shows the colour as text with a swatch of it (mpv\'s alpha first, CSS\'s last)', () => {
    const { field, container } = renderColor('#80FF0000');
    expect(field.value).toBe('#80FF0000');
    expect(field.placeholder).toBe('#RRGGBB or #AARRGGBB');
    expect(container.querySelector('[aria-hidden]')?.getAttribute('style')).toContain('#FF000080');
  });

  test('is saved when the field is left, in mpv\'s form', () => {
    const { onChange, field } = renderColor();
    fireEvent.change(field, { target: { value: 'ff8800' } });
    // Nothing on the way.
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(field);
    expect(onChange.mock.calls).toEqual([['#FF8800']]);
  });

  test('is saved with Enter, once', () => {
    const { onChange, field } = renderColor();
    fireEvent.change(field, { target: { value: '#80000000' } });
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(false);
    fireEvent.blur(field);
    expect(onChange.mock.calls).toEqual([['#80000000']]);
  });

  test('what is no colour is not sent: the row is told why, and the text stays to be corrected', () => {
    const { onChange, onInvalid, field } = renderColor();
    for (const typed of ['red', '#12', '#12345', 'ff88']) {
      fireEvent.change(field, { target: { value: typed } });
      fireEvent.blur(field);
      expect(field.value, typed).toBe(typed);
      expect(onInvalid).toHaveBeenLastCalledWith('settings.errors.invalidColor');
    }
    expect(onChange).not.toHaveBeenCalled();

    // Enter says the same, and is handled.
    fireEvent.change(field, { target: { value: 'blue' } });
    onInvalid.mockClear();
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(false);
    expect(onInvalid).toHaveBeenCalledWith('settings.errors.invalidColor');
    expect(onChange).not.toHaveBeenCalled();
  });

  test('typing again takes the message away, and a good colour is sent', () => {
    const { onChange, onInvalid, field } = renderColor();
    fireEvent.change(field, { target: { value: 'red' } });
    fireEvent.blur(field);
    expect(onInvalid.mock.calls).toEqual([['settings.errors.invalidColor']]);

    fireEvent.change(field, { target: { value: 'ff0000' } });
    expect(onInvalid.mock.calls).toEqual([['settings.errors.invalidColor'], [null]]);
    fireEvent.blur(field);
    expect(onChange.mock.calls).toEqual([['#FF0000']]);
    // Nothing more to take away.
    expect(onInvalid).toHaveBeenCalledTimes(2);
  });

  test('Esc drops a text that was refused, and the message with it', () => {
    const { onChange, onInvalid, field } = renderColor('#FFFFFFFF');
    fireEvent.change(field, { target: { value: 'red' } });
    fireEvent.blur(field);
    expect(fireEvent.keyDown(field, { key: 'Escape' })).toBe(false);
    expect(field.value).toBe('#FFFFFFFF');
    expect(onInvalid).toHaveBeenLastCalledWith(null);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('an empty field is sent: it takes the colour out of mpv.conf', () => {
    const { onChange, onInvalid, field } = renderColor('#FFFFFFFF');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(onChange.mock.calls).toEqual([['']]);
    expect(onInvalid).not.toHaveBeenCalled();
  });

  test('leaving the field with the colour it had saves nothing', () => {
    const { onChange, field } = renderColor('#FFFFFFFF');
    fireEvent.change(field, { target: { value: 'ffffffff' } });
    fireEvent.blur(field);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.focus(field);
    fireEvent.blur(field);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('Esc drops what was typed, and is handled', () => {
    const { onChange, field } = renderColor('#FFFFFFFF');
    fireEvent.change(field, { target: { value: '123456' } });
    expect(fireEvent.keyDown(field, { key: 'Escape' })).toBe(false);
    expect(field.value).toBe('#FFFFFFFF');
    fireEvent.blur(field);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('Esc with nothing typed is not the field\'s', () => {
    const { field } = renderColor();
    expect(fireEvent.keyDown(field, { key: 'Escape' })).toBe(true);
  });
});

describe('LangListField', () => {
  function renderLanguages(value = 'cs,en') {
    const onChange = vi.fn();
    const onInvalid = vi.fn();
    render(
      <>
        <span id="label">Languages</span>
        <LangListField
          id="langs"
          labelId="label"
          value={value}
          onChange={onChange}
          onInvalid={onInvalid}
        />
      </>,
    );
    return {
      onChange,
      onInvalid,
      field: screen.getByRole('textbox', { name: 'Languages' }) as HTMLInputElement,
    };
  }

  test('a list with something in it that is no code is not sent, and the text stays to be corrected', () => {
    const { onChange, onInvalid, field } = renderLanguages();
    fireEvent.change(field, { target: { value: 'cs, czech' } });
    fireEvent.blur(field);
    expect(onChange).not.toHaveBeenCalled();
    expect(onInvalid.mock.calls).toEqual([['settings.errors.invalidLangList']]);
    expect(field.value).toBe('cs, czech');

    fireEvent.change(field, { target: { value: 'cs, cz' } });
    expect(onInvalid.mock.calls).toEqual([['settings.errors.invalidLangList'], [null]]);
    fireEvent.blur(field);
    expect(onChange.mock.calls).toEqual([['cs,cz']]);
  });

  test('writes the list with a space after each comma', () => {
    const { field } = renderLanguages('cs,en,de');
    expect(field.value).toBe('cs, en, de');
  });

  test('saves the typed list in mpv\'s form when the field is left', () => {
    const { onChange, field } = renderLanguages();
    fireEvent.change(field, { target: { value: 'cs; EN  de' } });
    fireEvent.blur(field);
    expect(onChange.mock.calls).toEqual([['cs,en,de']]);
  });

  test('an empty field saves an empty list', () => {
    const { onChange, field } = renderLanguages();
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(onChange.mock.calls).toEqual([['']]);
  });

  test('the same list written another way saves nothing', () => {
    const { onChange, field } = renderLanguages('cs,en');
    fireEvent.change(field, { target: { value: 'cs , en' } });
    fireEvent.blur(field);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('FontField', () => {
  const FONTS = ['Arial', 'Segoe UI', 'Verdana'];

  function renderFont(value = 'sans-serif') {
    rust({ system_fonts: FONTS });
    const onChange = vi.fn();
    render(
      <>
        <span id="label">Font</span>
        <FontField id="font" labelId="label" value={value} onChange={onChange} />
      </>,
    );
    const button = () => screen.getByRole('button', { name: /^Font/ }) as HTMLButtonElement;
    return { onChange, button };
  }

  test('lists the installed fonts after "Default", and can be filtered', async () => {
    const { onChange, button } = renderFont();
    // The fonts are on their way.
    expect(button().disabled).toBe(true);
    await waitFor(() => {
      expect(button().disabled).toBe(false);
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('system_fonts');
    // A font that is not in the list (mpv's default) is shown as it is.
    expect(button().textContent).toBe('sans-serif');

    fireEvent.click(button());
    expect(screen.getAllByRole('option').map((each) => each.textContent)).toEqual([
      'Default',
      'Arial',
      'Segoe UI',
      'Verdana',
    ]);

    fireEvent.change(screen.getByRole('textbox', { name: 'Filter fonts' }), { target: { value: 'seg' } });
    expect(screen.getAllByRole('option').map((each) => each.textContent)).toEqual(['Segoe UI']);
    fireEvent.click(screen.getByRole('option', { name: 'Segoe UI' }));
    expect(onChange).toHaveBeenCalledWith('Segoe UI');
  });

  test('"Default" takes the font out of mpv.conf: it is the empty value', async () => {
    const { onChange, button } = renderFont('Arial');
    await waitFor(() => {
      expect(button().disabled).toBe(false);
    });
    fireEvent.click(button());
    fireEvent.click(screen.getByRole('option', { name: 'Default' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  test('fonts that cannot be read are said, with a way to read them again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(invoke).mockImplementation((() => Promise.reject('no fonts')) as unknown as typeof invoke);
    const onChange = vi.fn();
    render(
      <>
        <span id="label">Font</span>
        <FontField id="font" labelId="label" value="Arial" onChange={onChange} />
      </>,
    );
    const button = () => screen.getByRole('button', { name: /^Font/ }) as HTMLButtonElement;

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The list could not be read.');
    expect(button().textContent).toBe('Arial');
    expect(button().disabled).toBe(true);

    rust({ system_fonts: FONTS });
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(button().disabled).toBe(false);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(button());
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });
});

describe('DeviceField', () => {
  const DEVICES = [
    { name: 'auto', description: 'Autoselect device' },
    { name: 'wasapi/{0.0.0.00000000}.{abc}', description: 'Speakers (Realtek)' },
  ];

  test('names the devices as the system does, and no device named is "auto"', async () => {
    rust({ settings_audio_devices: DEVICES });
    const onChange = vi.fn();
    render(
      <>
        <span id="label">Device</span>
        <DeviceField id="device" labelId="label" value="" onChange={onChange} />
      </>,
    );
    const button = () => screen.getByRole('button', { name: /^Device/ }) as HTMLButtonElement;
    await waitFor(() => {
      expect(button().disabled).toBe(false);
    });
    expect(button().textContent).toBe('Autoselect device');

    fireEvent.click(button());
    expect(screen.getByRole('option', { name: 'Autoselect device' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('option', { name: 'Speakers (Realtek)' }));
    expect(onChange).toHaveBeenCalledWith('wasapi/{0.0.0.00000000}.{abc}');
  });

  test('says so when mpv lists no device', async () => {
    rust({ settings_audio_devices: [] });
    render(
      <>
        <span id="label">Device</span>
        <DeviceField id="device" labelId="label" value="auto" onChange={() => undefined} />
      </>,
    );
    const button = () => screen.getByRole('button', { name: /^Device/ }) as HTMLButtonElement;
    await waitFor(() => {
      expect(button().disabled).toBe(false);
    });
    fireEvent.click(button());
    expect(screen.getByText('No audio devices found')).toBeTruthy();
  });

  test('a list that cannot be read is said, with a way to read it again, not shown as an empty one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(invoke).mockImplementation((() => Promise.reject('no player')) as unknown as typeof invoke);
    const onChange = vi.fn();
    render(
      <>
        <span id="label">Device</span>
        <DeviceField id="device" labelId="label" value="wasapi/gone" onChange={onChange} />
      </>,
    );
    const button = () => screen.getByRole('button', { name: /^Device/ }) as HTMLButtonElement;

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The list could not be read.');
    expect(warn).toHaveBeenCalled();
    // The value stays as it is, and there is no list to choose from (nor an empty one).
    expect(button().textContent).toBe('wasapi/gone');
    expect(button().disabled).toBe(true);
    expect(screen.queryByText('No audio devices found')).toBeNull();

    // Read again: the list comes.
    rust({ settings_audio_devices: DEVICES });
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(button().disabled).toBe(false);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(button());
    fireEvent.click(screen.getByRole('option', { name: 'Speakers (Realtek)' }));
    expect(onChange).toHaveBeenCalledWith('wasapi/{0.0.0.00000000}.{abc}');
  });

  test('an answer that is no list is a failure too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    rust({ settings_audio_devices: { not: 'a list' } });
    render(
      <>
        <span id="label">Device</span>
        <DeviceField id="device" labelId="label" value="auto" onChange={() => undefined} />
      </>,
    );
    expect((await screen.findByRole('alert')).textContent).toContain('The list could not be read.');
  });
});

describe('ShaderListField', () => {
  function renderShaders(value: readonly string[]) {
    const onChange = vi.fn();
    render(
      <>
        <span id="label">Shaders</span>
        <ShaderListField id="shaders" labelId="label" value={value} onChange={onChange} />
      </>,
    );
    return { onChange };
  }

  test('a checkbox for each file, the ones that are on checked', async () => {
    rust({ settings_list_shaders: ['Anime4K.glsl', 'ravu.hook'] });
    renderShaders(['ravu.hook']);

    const anime = await screen.findByRole('checkbox', { name: 'Anime4K.glsl' });
    expect((anime as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'ravu.hook' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('group', { name: 'Shaders' })).toBeTruthy();
  });

  test('a file turned on goes to the end of the list, one turned off leaves it', async () => {
    rust({ settings_list_shaders: ['a.glsl', 'b.glsl', 'c.glsl'] });
    const { onChange } = renderShaders(['c.glsl']);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'a.glsl' }));
    expect(onChange).toHaveBeenLastCalledWith(['c.glsl', 'a.glsl']);

    fireEvent.click(screen.getByRole('checkbox', { name: 'c.glsl' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  test('a shader the option names that is not in the folder is listed, so that it can be turned off', async () => {
    rust({ settings_list_shaders: ['a.glsl'] });
    const { onChange } = renderShaders(['gone.glsl']);

    await screen.findByRole('checkbox', { name: 'a.glsl' });
    const gone = screen.getByRole('checkbox', { name: 'gone.glsl' }) as HTMLInputElement;
    expect(gone.checked).toBe(true);
    fireEvent.click(gone);
    expect(onChange).toHaveBeenCalledWith([]);
  });

  test('an empty shaders folder says so', async () => {
    rust({ settings_list_shaders: [] });
    renderShaders([]);
    expect(await screen.findByText('The shaders folder has no files yet.')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  test('files that cannot be listed are said, not shown as an empty folder, and can be listed again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(invoke).mockImplementation((() => Promise.reject('no folder')) as unknown as typeof invoke);
    renderShaders(['ravu.hook']);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The list could not be read.');
    expect(screen.queryByText('The shaders folder has no files yet.')).toBeNull();
    // What is on is still shown, and cannot be changed meanwhile.
    const ravu = screen.getByRole('checkbox', { name: 'ravu.hook' }) as HTMLInputElement;
    expect(ravu.checked).toBe(true);
    expect(ravu.disabled).toBe(true);

    rust({ settings_list_shaders: ['Anime4K.glsl', 'ravu.hook'] });
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('checkbox', { name: 'Anime4K.glsl' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
