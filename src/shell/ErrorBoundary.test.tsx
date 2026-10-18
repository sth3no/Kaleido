import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../i18n';
import ErrorBoundary, { describeUiError } from './ErrorBoundary';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

/** A page that cannot draw. */
function BrokenPage(): never {
  throw new TypeError('the title is missing');
}

/** What the UI sent Rust for the log. */
const logged = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === 'system_ui_error')
    .map(([, args]) => (args as { message: string }).message);

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  // React reports a caught error on the console too.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  setLanguage('en');
});

describe('the error boundary', () => {
  test('without an error the app is drawn as it is, and nothing is sent', () => {
    render(
      <ErrorBoundary>
        <p>The start screen</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('The start screen')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(logged()).toEqual([]);
  });

  test('a child that throws leaves the recover view, and the error goes to Rust for the log', () => {
    render(
      <ErrorBoundary>
        <p>The start screen</p>
        <BrokenPage />
      </ErrorBoundary>,
    );

    const view = screen.getByRole('alertdialog', { name: "Kaleido's window ran into a problem" });
    expect(screen.queryByText('The start screen')).toBeNull();
    expect(view.textContent).toContain('written in the log');
    // The keyboard reaches nothing else: the way back has the focus.
    const reload = within(view).getByRole('button', { name: 'Reload' });
    expect(document.activeElement).toBe(reload);

    const [message, ...more] = logged();
    expect(more).toEqual([]);
    expect(message).toContain('TypeError: the title is missing');
    // The components it came from.
    expect(message).toContain('in components:');
    expect(message).toContain('BrokenPage');
  });

  test('Reload reloads the UI', () => {
    const onReload = vi.fn();
    render(
      <ErrorBoundary onReload={onReload}>
        <BrokenPage />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  test('the recover view speaks the language of the app', () => {
    setLanguage('cs');
    render(
      <ErrorBoundary>
        <BrokenPage />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alertdialog', { name: 'Okno Kaleida narazilo na chybu' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Načíst znovu' })).toBeTruthy();
  });

  test('a log that cannot be written leaves the recover view as it is', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(invoke).mockRejectedValueOnce('no Rust');
    render(
      <ErrorBoundary>
        <BrokenPage />
      </ErrorBoundary>,
    );
    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith('system_ui_error', 'no Rust');
    });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});

describe('describeUiError', () => {
  test('the stack says the name and the message once', () => {
    const error = new RangeError('too far');
    const text = describeUiError(error, '\n    at Seekbar\n    at PlayerPage');
    expect(text.startsWith('RangeError: too far\n')).toBe(true);
    expect(text.match(/too far/g)).toHaveLength(1);
    expect(text.endsWith('in components:\n    at Seekbar\n    at PlayerPage')).toBe(true);
  });

  test('an error without a stack, and what is thrown that is no error', () => {
    const bare = new Error('no stack');
    bare.stack = undefined;
    expect(describeUiError(bare)).toBe('Error: no stack');
    expect(describeUiError('a string')).toBe('a string');
    expect(describeUiError(42, null)).toBe('42');
  });
});
