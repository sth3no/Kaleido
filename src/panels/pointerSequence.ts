/**
 * For tests: a click with the mouse as the browser delivers it, not the lone `click` event that
 * `fireEvent.click` is. What happens to the focus decides whether Space goes to the control or to mpv
 * afterwards (`input/forward.ts`, Ruling R44), and the focus is moved by the events in between.
 */

import { act, fireEvent } from '@testing-library/react';

/** What takes the focus when it is pressed with a pointer. */
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]';

/**
 * Presses and releases the main button on `element`: `pointerdown`; unless a handler cancelled it,
 * `mousedown` and its default action (the nearest focusable element takes the focus, or none does
 * and the one that had it loses it); `pointerup`; `mouseup`; `click`. A cancelled `pointerdown` gives
 * no mouse events and moves no focus, but the click still comes.
 */
export function realClick(element: HTMLElement): void {
  const press = { button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse' };
  const delivered = fireEvent.pointerDown(element, press);
  if (delivered) {
    fireEvent.mouseDown(element, { button: 0, buttons: 1 });
    const target = element.closest<HTMLElement>(FOCUSABLE);
    act(() => {
      if (target) target.focus();
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
  }
  fireEvent.pointerUp(element, { ...press, buttons: 0 });
  if (delivered) fireEvent.mouseUp(element, { button: 0 });
  fireEvent.click(element, { button: 0, detail: 1 });
}
