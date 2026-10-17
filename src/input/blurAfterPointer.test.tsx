import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { blurAfterPointer, shouldForward } from './forward';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

/** A Space pressed now, dispatched where the focus is (as the browser does). */
function space(): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}

test('a click with the pointer gives the focus back, so Space goes to mpv again', () => {
  render(
    <button type="button" {...blurAfterPointer}>
      Fullscreen
    </button>,
  );
  const button = screen.getByRole('button', { name: 'Fullscreen' });

  // The press focuses the button (the browser does it on pointerdown), the release lets go.
  fireEvent.pointerDown(button);
  button.focus();
  expect(document.activeElement).toBe(button);
  fireEvent.pointerUp(button);
  fireEvent.click(button);

  expect(document.activeElement).not.toBe(button);
  // Space now goes to mpv (pause) instead of pressing the button a second time.
  expect(shouldForward(space())).toBe(true);
});

test('focus that came with the keyboard stays, and Space presses the button', () => {
  const pressed = vi.fn();
  render(
    <button type="button" onClick={pressed} {...blurAfterPointer}>
      Fullscreen
    </button>,
  );
  const button = screen.getByRole('button', { name: 'Fullscreen' });

  // Tab to it, and Enter: no pointer was released on it.
  button.focus();
  fireEvent.keyDown(button, { key: 'Enter', code: 'Enter' });
  fireEvent.click(button);
  fireEvent.keyUp(button, { key: 'Enter', code: 'Enter' });

  expect(pressed).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(button);
  // Space is the button's, not mpv's (R18).
  expect(shouldForward(space())).toBe(false);
});
