import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../i18n';
import HomeScreen from './HomeScreen';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

/** How Rust answers a command; the ones not named resolve with `null`. */
function rust(answers: Record<string, (args: unknown) => unknown> = {}) {
  vi.mocked(invoke).mockImplementation(((command: string, args?: unknown) =>
    Promise.resolve(answers[command]?.(args) ?? null)) as unknown as typeof invoke);
}

/** The commands the screen sent to Rust, as `[name, arguments]`. */
const sent = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

/** Rust says Ctrl+V found no link (`system:paste-empty`). */
function pasteEmptyFromRust() {
  const subscription = vi.mocked(listen).mock.calls.find(([event]) => event === 'system:paste-empty');
  if (!subscription) throw new Error('the start screen does not listen to system:paste-empty');
  const callback = subscription[1] as (event: { payload: unknown }) => void;
  act(() => {
    callback({ payload: {} });
  });
}

const openFile = () => screen.getByRole('button', { name: 'Open file' });
const pasteLink = () => screen.getByRole('button', { name: 'Paste link' });
const pasteField = () => screen.queryByRole('textbox', { name: 'Link to a video' });

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockClear();
  rust();
});

afterEach(() => {
  vi.restoreAllMocks();
  setLanguage('en');
});

describe('the drop zone', () => {
  test('says what to do and offers both ways to open something', () => {
    render(<HomeScreen />);

    const zone = screen.getByRole('region', { name: 'Drop a video here' });
    expect(within(zone).getByRole('heading', { level: 1 }).textContent).toBe('Drop a video here');
    expect(within(zone).getByRole('button', { name: 'Open file' })).toBeTruthy();
    expect(within(zone).getByRole('button', { name: 'Paste link' })).toBeTruthy();
    // Ctrl+V is told to screen readers as the button's shortcut, not as part of its name.
    expect(pasteLink().getAttribute('aria-keyshortcuts')).toBe('Control+V');
  });

  test('lights up while something is dragged over the window', () => {
    const { rerender } = render(<HomeScreen />);
    const zone = screen.getByRole('region', { name: 'Drop a video here' });
    expect(zone.getAttribute('data-dragging')).toBe('false');

    rerender(<HomeScreen dragging />);
    expect(zone.getAttribute('data-dragging')).toBe('true');

    rerender(<HomeScreen dragging={false} />);
    expect(zone.getAttribute('data-dragging')).toBe('false');
  });
});

describe('opening a file', () => {
  test('open button asks Rust for the dialog', () => {
    render(<HomeScreen />);

    fireEvent.click(openFile());

    expect(sent('system_open_dialog')).toEqual([['system_open_dialog', { purpose: 'media' }]]);
  });

  test('a dialog that cannot open is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    rust({ system_open_dialog: () => Promise.reject('no dialog') });
    render(<HomeScreen />);

    fireEvent.click(openFile());

    await waitFor(() => {
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});

describe('pasting a link', () => {
  test('a link on the clipboard plays and no field appears', async () => {
    rust({ system_paste: () => 'played' });
    render(<HomeScreen />);

    fireEvent.click(pasteLink());

    expect(sent('system_paste')).toHaveLength(1);
    // Let the answer arrive and be handled.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(pasteField()).toBeNull();
  });

  test('paste field appears when the clipboard has no link', async () => {
    rust({ system_paste: () => 'empty' });
    render(<HomeScreen />);
    expect(pasteField()).toBeNull();

    fireEvent.click(pasteLink());

    const field = await screen.findByRole('textbox', { name: 'Link to a video' });
    expect(document.activeElement).toBe(field);
  });

  test('paste field also appears when Rust says Ctrl+V found no link', () => {
    render(<HomeScreen />);
    expect(pasteField()).toBeNull();

    pasteEmptyFromRust();

    expect(pasteField()).toBeTruthy();
    expect(document.activeElement).toBe(pasteField());
  });

  test('paste field is offered when the clipboard cannot be asked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    rust({ system_paste: () => Promise.reject('no clipboard') });
    render(<HomeScreen />);

    fireEvent.click(pasteLink());

    await screen.findByRole('textbox', { name: 'Link to a video' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('Ctrl+V again takes the focus back into the open field, with the text in it', () => {
    render(<HomeScreen />);
    pasteEmptyFromRust();
    fireEvent.change(pasteField() as HTMLElement, { target: { value: 'https://exa' } });
    openFile().focus();

    pasteEmptyFromRust();

    expect(document.activeElement).toBe(pasteField());
    expect((pasteField() as HTMLInputElement).value).toBe('https://exa');
  });

  test('paste field shows the error Rust returns', async () => {
    rust({
      system_open_text: () => Promise.reject({ source: 'nonsense', kind: 'invalid' }),
    });
    render(<HomeScreen />);
    pasteEmptyFromRust();

    fireEvent.change(pasteField() as HTMLElement, { target: { value: 'nonsense' } });
    fireEvent.keyDown(pasteField() as HTMLElement, { key: 'Enter' });

    expect(sent('system_open_text')).toEqual([['system_open_text', { text: 'nonsense' }]]);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('That is not a link.');
    // It is at the field, which is still there.
    expect(alert.parentElement?.contains(pasteField())).toBe(true);
  });

  test('a link entered in the field plays and the field goes', async () => {
    render(<HomeScreen />);
    pasteEmptyFromRust();

    fireEvent.change(pasteField() as HTMLElement, { target: { value: 'https://youtu.be/x' } });
    fireEvent.keyDown(pasteField() as HTMLElement, { key: 'Enter' });

    expect(sent('system_open_text')).toEqual([['system_open_text', { text: 'https://youtu.be/x' }]]);
    await waitFor(() => {
      expect(pasteField()).toBeNull();
    });
  });

  test('Esc closes the paste field and the focus goes back to the Paste link button', () => {
    render(<HomeScreen />);
    pasteEmptyFromRust();
    expect(document.activeElement).toBe(pasteField());

    const handled = !fireEvent.keyDown(pasteField() as HTMLElement, { key: 'Escape' });

    expect(handled).toBe(true);
    expect(pasteField()).toBeNull();
    expect(document.activeElement).toBe(pasteLink());
  });

  test('the field closes with Cancel too, and the focus goes back to the button', () => {
    render(<HomeScreen />);
    pasteEmptyFromRust();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(pasteField()).toBeNull();
    expect(document.activeElement).toBe(pasteLink());
  });

  test('it stops listening for Ctrl+V when the screen goes', () => {
    const unlisten = vi.fn();
    // The screen subscribes to one event.
    vi.mocked(listen).mockImplementationOnce(() => Promise.resolve(unlisten));
    const { unmount } = render(<HomeScreen />);

    unmount();

    // The subscription resolves a moment after the effect; the cleanup stops it then.
    return waitFor(() => {
      expect(unlisten).toHaveBeenCalledTimes(1);
    });
  });
});

describe('the roadmap card', () => {
  test('roadmap card has the ROADMAPA badge and opens the roadmap', () => {
    setLanguage('cs');
    render(<HomeScreen />);

    const card = screen.getByRole('region', { name: 'Pokračovat ve sledování' });
    expect(within(card).getByRole('heading', { level: 2 }).textContent).toBe(
      'Pokračovat ve sledování',
    );
    expect(within(card).getByText('ROADMAPA')).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: 'Co chystáme →' }));

    expect(sent('system_open_roadmap')).toEqual([['system_open_roadmap']]);
  });

  test('the English card says the same', () => {
    render(<HomeScreen />);

    const card = screen.getByRole('region', { name: 'Continue watching' });
    expect(within(card).getByText('ROADMAP')).toBeTruthy();
    expect(within(card).getByText(/Recently played videos/)).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: 'What we are building →' }));

    expect(sent('system_open_roadmap')).toHaveLength(1);
  });

  test('a roadmap that cannot be opened is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    rust({ system_open_roadmap: () => Promise.reject('no browser') });
    render(<HomeScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'What we are building →' }));

    await waitFor(() => {
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});
