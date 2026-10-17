import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../i18n';
import PasteField from './PasteField';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

/** How Rust answers a command; the ones not named resolve with `null`. */
function rust(answers: Record<string, (args: unknown) => unknown> = {}) {
  vi.mocked(invoke).mockImplementation(((command: string, args?: unknown) =>
    Promise.resolve(answers[command]?.(args) ?? null)) as unknown as typeof invoke);
}

const LINK = 'https://example.com/watch?v=abc';

const field = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Link to a video' });

/** Types `text` into the field, as the user does. */
const type = (text: string) => {
  fireEvent.change(field(), { target: { value: text } });
};

const enter = () => fireEvent.keyDown(field(), { key: 'Enter' });

/** The calls of `system_open_text`. */
const opened = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'system_open_text');

function mount(focusToken = 0) {
  const onClose = vi.fn();
  const view = render(<PasteField onClose={onClose} focusToken={focusToken} />);
  return { onClose, ...view };
}

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  rust();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('opening', () => {
  test('the focus goes into the field', () => {
    mount();

    expect(document.activeElement).toBe(field());
  });

  test('a new focus token takes the focus back into the field, keeping the text', () => {
    const { rerender, onClose } = mount(1);
    type('half a link');
    screen.getByRole('button', { name: 'Cancel' }).focus();
    expect(document.activeElement).not.toBe(field());

    // Ctrl+V once more while the field is open.
    rerender(<PasteField onClose={onClose} focusToken={2} />);

    expect(document.activeElement).toBe(field());
    expect(field().value).toBe('half a link');
  });
});

describe('sending a link', () => {
  test('Enter sends the text without the space around it, and then the field closes', async () => {
    const { onClose } = mount();
    type(`  ${LINK} \n`);

    enter();

    expect(opened()).toEqual([['system_open_text', { text: LINK }]]);
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  test('the Play button sends it too', async () => {
    const { onClose } = mount();
    type(LINK);

    fireEvent.click(screen.getByRole('button', { name: 'Play' }));

    expect(opened()).toEqual([['system_open_text', { text: LINK }]]);
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  test('an empty field sends nothing', () => {
    const { onClose } = mount();

    enter();
    type('   ');
    enter();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));

    expect(opened()).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });

  test('Enter that confirms an IME composition sends nothing', () => {
    mount();
    type(LINK);

    fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });

    expect(opened()).toEqual([]);
  });

  test('a second Enter while Rust is still answering sends nothing again', async () => {
    let answer: () => void = () => undefined;
    vi.mocked(invoke).mockImplementation((() =>
      new Promise((resolve) => {
        answer = () => {
          resolve(null);
        };
      })) as unknown as typeof invoke);
    const { onClose } = mount();
    type(LINK);

    enter();
    enter();
    expect(opened()).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();

    answer();
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});

describe('what Rust says against the text', () => {
  test('a text that is no link is explained at the field, which stays open with its text', async () => {
    rust({ system_open_text: () => Promise.reject({ source: 'hello', kind: 'invalid' }) });
    const { onClose } = mount();
    type('hello');

    enter();

    const message = await screen.findByRole('alert');
    expect(message.textContent).toBe(
      'That is not a link. Paste one web address that starts with http:// or https://.',
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(field().value).toBe('hello');
    expect(document.activeElement).toBe(field());
    // The field and the message belong together for a screen reader.
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(field().getAttribute('aria-describedby')).toBe(message.id);
  });

  test('another scheme says that only web links work here', async () => {
    rust({
      system_open_text: () => Promise.reject({ source: 'file:///C:/a.mkv', kind: 'protocol' }),
    });
    mount();
    type('file:///C:/a.mkv');

    enter();

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only web links (http or https) can be pasted here. To play a file, use Open file or drop it on the window.',
    );
  });

  test('the message is in the language of the UI', async () => {
    rust({ system_open_text: () => Promise.reject({ source: 'x', kind: 'invalid' }) });
    setLanguage('cs');
    try {
      render(<PasteField onClose={vi.fn()} focusToken={0} />);
      fireEvent.change(screen.getByRole('textbox', { name: 'Odkaz na video' }), {
        target: { value: 'x' },
      });
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Odkaz na video' }), { key: 'Enter' });

      expect((await screen.findByRole('alert')).textContent).toContain('To není odkaz.');
    } finally {
      setLanguage('en');
    }
  });

  test('a failure that is not about the text says that something went wrong', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    rust({ system_open_text: () => Promise.reject('command system_open_text not found') });
    mount();
    type(LINK);

    enter();

    expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong.');
    // And the reason is in the log.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('the message goes away when the text changes, and a corrected link then plays', async () => {
    rust({
      system_open_text: (args) =>
        (args as { text: string }).text === LINK
          ? null
          : Promise.reject({ source: 'x', kind: 'invalid' }),
    });
    const { onClose } = mount();
    type('hello');
    enter();
    await screen.findByRole('alert');

    type(LINK);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(field().getAttribute('aria-invalid')).toBe('false');
    expect(field().hasAttribute('aria-describedby')).toBe(false);

    enter();
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});

describe('closing', () => {
  test('Esc closes the field, and mpv does not get the key', () => {
    const { onClose } = mount();

    // fireEvent answers false when the key was handled (preventDefault).
    const notHandled = fireEvent.keyDown(field(), { key: 'Escape' });

    expect(notHandled).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(opened()).toEqual([]);
  });

  test('Esc closes it from the buttons as well', () => {
    const { onClose } = mount();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Play' }), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('Cancel closes it', () => {
    const { onClose } = mount();
    type(LINK);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(opened()).toEqual([]);
  });

  test('other keys are left alone', () => {
    const { onClose } = mount();

    const notHandled = fireEvent.keyDown(field(), { key: 'a' });

    expect(notHandled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });
});
