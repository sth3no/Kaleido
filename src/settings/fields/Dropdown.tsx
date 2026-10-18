/**
 * A list to choose one from, for the select, the font and the audio device. A button shows the
 * choice; it opens the list **in the page**, under itself, and the rows below make room. It is not
 * a popover and not the browser's own select: both put their list in a layer of their own, outside
 * the page layer that the shell clips around the mini player (Ruling R46), and a list there could
 * be drawn over the video. This one is part of the page, so it is clipped with it like any row.
 *
 * - The list is a listbox of option buttons, as the track lists of quick settings are: the arrows,
 *   Home and End move through it and say so with `preventDefault` (mpv does not also get them), the
 *   chosen one is the one Tab reaches, Enter and Space choose, Esc closes it and the focus goes back
 *   to the button. The focus does not choose on the way. A letter jumps to the next option that
 *   starts with it (and is handled even when none does: while the list is open the letters are not
 *   mpv's).
 * - With `filterLabel` the list has a field to narrow it down by typing (the fonts): the focus goes
 *   there when it opens, the down arrow goes on to the list, Enter chooses the first match.
 * - It closes when the focus leaves it. After the pointer, the button is not given the focus back
 *   (Space would then press it, not pause the video); after the keyboard it is.
 * - A value the list does not have (a font mpv.conf names that is not installed, a device that was
 *   unplugged) is shown as it is on the button, and nothing is marked chosen.
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';

import panel from '../../panels/Panel.module.css';
import Icon, { CHECK, CHEVRON_DOWN } from '../../shell/Icon';
import { normalizeText } from '../search';
import styles from './Fields.module.css';
import type { FieldProps } from './FieldProps';

export interface DropdownOption {
  value: string;
  label: string;
}

export interface DropdownProps extends FieldProps<string> {
  options: readonly DropdownOption[];
  /** What the button says while the value is empty and not an option. */
  placeholder?: string;
  /** With it the open list has a field to filter it, called so for screen readers. */
  filterLabel?: string;
  /** Said under the field when no option is left. */
  emptyText?: string;
}

export default function Dropdown({
  id,
  labelId,
  value,
  onChange,
  describedBy,
  invalid,
  disabled,
  options,
  placeholder = '',
  filterLabel,
  emptyText,
}: DropdownProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  const shown = useMemo(() => {
    const needle = normalizeText(filter.trim());
    return needle === ''
      ? options
      : options.filter((option) => normalizeText(option.label).includes(needle));
  }, [options, filter]);
  const chosen = shown.findIndex((option) => option.value === value);
  // What Tab reaches and the list opens on: the chosen option, or the first.
  const entry = Math.max(0, chosen);
  const current = options.find((option) => option.value === value);
  const text = current?.label ?? (value === '' ? placeholder : value);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    setFilter('');
    if (returnFocus) trigger.current?.focus();
  };

  // The focus goes in when it opens: to the filter, else to the chosen option.
  useEffect(() => {
    if (!open) return;
    const start = root.current?.querySelector<HTMLElement>('[data-autofocus]');
    start?.focus({ preventScroll: true });
    // jsdom has no scrollIntoView.
    root.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);

  const choose = (option: DropdownOption, byKeyboard: boolean) => {
    close(byKeyboard);
    if (option.value !== value) onChange(option.value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (!open) {
      if (e.target === trigger.current && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        // Handled here: mpv does not get the arrow too.
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') {
      // Handled here: mpv does not get Esc, where it would leave fullscreen.
      e.preventDefault();
      close(true);
      return;
    }
    const active = document.activeElement;
    if (active === field.current) {
      const first = shown[0];
      if (e.key === 'ArrowDown' && first) {
        e.preventDefault();
        items.current[0]?.focus();
      } else if (e.key === 'Enter' && first && !e.nativeEvent.isComposing) {
        e.preventDefault();
        choose(first, true);
      }
      return;
    }
    const index = items.current.findIndex((item) => item !== null && item === active);
    if (index < 0) return;
    const last = shown.length - 1;
    if (e.key.length === 1 && e.key !== ' ') {
      // A letter jumps to the next option that starts with it. Handled either way: a letter
      // that finds nothing must not reach mpv (f is its fullscreen) while the list is open.
      e.preventDefault();
      const letter = normalizeText(e.key);
      for (let step = 1; step <= shown.length; step += 1) {
        const at = (index + step) % shown.length;
        if (normalizeText(shown[at]?.label ?? '').startsWith(letter)) {
          items.current[at]?.focus();
          break;
        }
      }
      return;
    }
    if (e.key === 'ArrowUp' && index === 0 && field.current) {
      e.preventDefault();
      field.current.focus();
      return;
    }
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(index + 1, last);
    else if (e.key === 'ArrowUp') next = Math.max(index - 1, 0);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next < 0) return;
    e.preventDefault();
    items.current[next]?.focus();
  };

  // The focus left the dropdown (a click elsewhere, Tab past the list): it closes.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!open) return;
    const next = e.relatedTarget;
    if (next instanceof Node && root.current?.contains(next)) return;
    close(false);
  };

  return (
    <div ref={root} className={styles.dropdown} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={trigger}
        id={id}
        type="button"
        className={styles.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        // The row's label, then what is chosen.
        aria-labelledby={`${labelId} ${id}`}
        aria-describedby={describedBy}
        data-invalid={invalid ? '' : undefined}
        disabled={disabled}
        onClick={(e) => {
          if (open) close(e.detail === 0);
          else setOpen(true);
        }}
      >
        <span className={styles.triggerText}>{text}</span>
        <Icon path={CHEVRON_DOWN} />
      </button>
      {open && (
        <div className={styles.panel}>
          {filterLabel !== undefined && (
            <input
              ref={field}
              type="text"
              className={styles.input}
              aria-label={filterLabel}
              data-autofocus=""
              autoComplete="off"
              spellCheck={false}
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
              }}
            />
          )}
          <div
            id={listId}
            role="listbox"
            aria-labelledby={labelId}
            // Focusable so that a click on its scrollbar keeps the focus inside the dropdown.
            tabIndex={-1}
            className={`${panel.options} ${styles.list}`}
          >
            {shown.map((option, index) => {
              const selected = index === chosen;
              return (
                <button
                  key={option.value}
                  ref={(element) => {
                    items.current[index] = element;
                  }}
                  type="button"
                  role="option"
                  className={panel.option}
                  aria-selected={selected}
                  tabIndex={index === entry ? 0 : -1}
                  data-autofocus={filterLabel === undefined && index === entry ? '' : undefined}
                  // No `blurAfterPointer` here: the blur at the pointer's release would close the
                  // list (below) before the click that chooses reached the option.
                  onClick={(e) => {
                    // A click with no pointer behind it (detail 0) is Enter or Space.
                    choose(option, e.detail === 0);
                  }}
                >
                  <span className={panel.name}>{option.label}</span>
                  {selected && <Icon path={CHECK} />}
                </button>
              );
            })}
          </div>
          {shown.length === 0 && emptyText !== undefined && (
            <p className={styles.empty}>{emptyText}</p>
          )}
        </div>
      )}
    </div>
  );
}
