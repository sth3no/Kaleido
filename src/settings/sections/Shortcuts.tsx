/**
 * Shortcuts (spec 8.10): every key that is bound in the player, plugins' included (mpv's
 * `input-bindings`, `settings_bindings`), grouped by where it comes from (Kaleido, Custom, mpv, and
 * each plugin by its name) and searchable by key, command and group.
 *
 * - **Change** waits for the next key press and moves the binding there (`settings_rebind`; Rust
 *   takes the command from the binding itself, the UI sends keys only). While it waits, the keys are
 *   the capture's: they are handled (`preventDefault`, so that `input/forward.ts` does not send them
 *   to mpv, and stopped, so that nothing else on the page sees them). A modifier on its own does not
 *   end the wait, Esc cancels it, and so does a click elsewhere or leaving the window. The name of
 *   the key is `toMpvKey`'s (`input/keys.ts`). A key that is Windows' or moves the focus (Tab) is
 *   refused with a word, since mpv never gets it (`shortcuts.ts`).
 * - A key that is bound already is shown with what it does, and is replaced only after a "Replace":
 *   Rust overwrites it (Task 11), so the question is the UI's.
 * - **Reset** puts the key back to what it is without the user (Kaleido's default, mpv's, the
 *   plugin's). A key the user made up has nothing to go back to: it does nothing, and is listed
 *   "Disabled" like any key that was moved away, until the next start.
 * - The list is one stop for Tab: the arrows move through the buttons of the rows (up and down
 *   through the rows, left and right in a row; Home and End to the first and the last row), and the
 *   keys they handle are `preventDefault`ed, so that mpv does not also get them. After a change the
 *   focus follows the shortcut, if the list had it.
 * - What Rust refuses is said in the row. A player that is not up answers with no bindings, which
 *   the page says, and offers to read again.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../../input/forward';
import { settingsBindings, settingsRebind, settingsResetBinding } from '../../ipc/commands';
import type { Binding, BindingSource } from '../../ipc/types';
import {
  displayCommand,
  filterBindings,
  groupBindings,
  isSilenced,
  readCapture,
  sameKey,
} from '../shortcuts';
import { isSettingsError } from '../useSetting';
import styles from './Shortcuts.module.css';

/** A key the user wants for a shortcut, which another shortcut has. */
interface Conflict {
  from: string;
  to: string;
  taken: Binding;
}

/** The key of the text that says why Rust refused to change a shortcut. */
function failureText(reason: unknown): string {
  if (isSettingsError(reason)) {
    switch (reason.type) {
      case 'invalid':
        return reason.key === 'newKey'
          ? 'settings.shortcuts.errors.badKey'
          : 'settings.shortcuts.errors.cannotChange';
      case 'notAllowed':
        return 'settings.shortcuts.errors.cannotChange';
      case 'io':
        return 'settings.shortcuts.errors.io';
      case 'unavailable':
        return 'settings.errors.unavailable';
    }
  }
  return 'settings.shortcuts.errors.generic';
}

const changeId = (key: string) => `${key}|change`;
const resetId = (key: string) => `${key}|reset`;

export default function Shortcuts() {
  const { t } = useTranslation();
  /** `null` until the first read answers. */
  const [bindings, setBindings] = useState<readonly Binding[] | null>(null);
  /** The last read failed (the list, if there is one, is the one before). */
  const [readFailed, setReadFailed] = useState(false);
  const [query, setQuery] = useState('');
  /** The key whose shortcut waits for its new key. */
  const [capturing, setCapturing] = useState<string | null>(null);
  /** The key of a text that says what was wrong with the last key pressed while waiting. */
  const [note, setNote] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  /** The key whose change is on its way to Rust. */
  const [busy, setBusy] = useState<string | null>(null);
  /** The key of the text that says why a shortcut could not be changed, by key. */
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  /** What was done, for the screen reader (the list moves under it). */
  const [announcement, setAnnouncement] = useState('');
  /** The button that Tab reaches: the one that had the focus last. */
  const [rover, setRover] = useState<string | null>(null);
  /** The button to give the focus once the list is drawn again. */
  const [focusId, setFocusId] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  /** Counts the reads: an answer that is not the newest decides nothing. */
  const reads = useRef(0);
  const latest = useRef(bindings);
  useLayoutEffect(() => {
    latest.current = bindings;
  });

  const read = useCallback(async (): Promise<void> => {
    reads.current += 1;
    const turn = reads.current;
    try {
      const answer = await settingsBindings();
      if (!Array.isArray(answer)) throw new Error('settings_bindings did not answer with a list');
      if (turn === reads.current) {
        setBindings(answer);
        setReadFailed(false);
      }
    } catch (error) {
      console.warn('cannot read the shortcuts', error);
      if (turn === reads.current) setReadFailed(true);
    }
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  // --- Changing and resetting -----------------------------------------------------------------------

  const withoutError = useCallback((key: string) => {
    setErrors((now) => Object.fromEntries(Object.entries(now).filter(([name]) => name !== key)));
  }, []);

  /** Whether the focus is in the list (and so is to follow the shortcut, not to be dropped). */
  const listHasFocus = useCallback(
    () => root.current?.contains(document.activeElement) ?? false,
    [],
  );

  const rebind = useCallback(
    async (from: string, to: string): Promise<void> => {
      setConflict(null);
      setBusy(from);
      withoutError(from);
      setAnnouncement('');
      const follow = listHasFocus();
      try {
        await settingsRebind(from, to);
        await read();
        setAnnouncement(t('settings.shortcuts.changed', { from, to }));
        if (follow) setFocusId(changeId(to));
      } catch (reason) {
        console.warn(`cannot move the shortcut ${from} to ${to}`, reason);
        setErrors((now) => ({ ...now, [from]: failureText(reason) }));
      } finally {
        setBusy(null);
      }
    },
    [read, t, withoutError, listHasFocus],
  );

  const reset = async (key: string): Promise<void> => {
    setConflict(null);
    setBusy(key);
    withoutError(key);
    setAnnouncement('');
    const follow = listHasFocus();
    try {
      await settingsResetBinding(key);
      await read();
      setAnnouncement(t('settings.shortcuts.wasReset', { key }));
      if (follow) setFocusId(resetId(key));
    } catch (reason) {
      console.warn(`cannot reset the shortcut ${key}`, reason);
      setErrors((now) => ({ ...now, [key]: failureText(reason) }));
    } finally {
      setBusy(null);
    }
  };

  /** The user pressed `to` for the shortcut on `from`: moved at once, or after a "Replace" if `to` is taken. */
  const propose = useCallback(
    (from: string, to: string) => {
      if (sameKey(from, to)) return;
      const taken = latest.current?.find((binding) => sameKey(binding.key, to) && !isSilenced(binding));
      if (taken) setConflict({ from, to, taken });
      else void rebind(from, to);
    },
    [rebind],
  );

  // --- Waiting for the new key ----------------------------------------------------------------------

  useEffect(() => {
    if (capturing === null) return undefined;
    const from = capturing;
    const cancel = () => {
      setCapturing(null);
      setNote(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // Whatever is pressed now is the capture's: mpv does not get it (`input/forward.ts` leaves a
      // key that is handled alone), and nothing else on the page, Esc's closing of things included.
      e.preventDefault();
      e.stopPropagation();
      // A held key repeats; the first press is the answer.
      if (e.repeat) return;
      const pressed = readCapture(e);
      switch (pressed.type) {
        case 'cancel':
          cancel();
          break;
        case 'wait':
          break;
        case 'reserved':
          setNote('settings.shortcuts.reserved');
          break;
        case 'key':
          cancel();
          propose(from, pressed.key);
          break;
      }
    };
    // A click outside the row (or leaving the window) ends the wait: the keys are the page's again.
    const onPointerDown = (e: PointerEvent) => {
      const row = e.target instanceof Element ? e.target.closest('[data-binding]') : null;
      if (row?.getAttribute('data-binding') !== from) cancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', cancel);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [capturing, propose]);

  // --- What is shown --------------------------------------------------------------------------------

  const sourceLabel = useCallback(
    (source: BindingSource) =>
      source.type === 'plugin' ? source.name : t(`settings.shortcuts.groups.${source.type}`),
    [t],
  );
  const visible = useMemo(
    () => filterBindings(bindings ?? [], query, sourceLabel),
    [bindings, query, sourceLabel],
  );
  const groups = useMemo(() => groupBindings(visible), [visible]);
  const searching = query.trim() !== '';

  /** The buttons of the list in the order of the page, by id: the first is where Tab goes by default. */
  const buttons = useMemo(
    () =>
      groups.flatMap((group) =>
        group.bindings.flatMap((binding) =>
          isSilenced(binding) ? [resetId(binding.key)] : [changeId(binding.key), resetId(binding.key)],
        ),
      ),
    [groups],
  );
  const entry = rover !== null && buttons.includes(rover) ? rover : (buttons[0] ?? null);

  // The focus goes where a change put it, once the list shows the change.
  useEffect(() => {
    if (focusId === null) return;
    const target = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-rove-id]') ?? []).find(
      (element) => element.dataset.roveId === focusId,
    );
    target?.focus();
    setFocusId(null);
  }, [focusId, bindings]);

  const onListFocus = (e: ReactFocusEvent<HTMLElement>) => {
    const id = e.target instanceof HTMLElement ? e.target.dataset.roveId : undefined;
    if (id !== undefined) setRover(id);
  };

  const onListKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const target = e.target;
    if (!(target instanceof HTMLElement) || target.dataset.roveId === undefined) return;
    const rows = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-binding]') ?? []);
    const row = target.closest<HTMLElement>('[data-binding]');
    if (row === null) return;
    const inRow = (element: HTMLElement | undefined) =>
      Array.from(element?.querySelectorAll<HTMLElement>('[data-rove-id]') ?? []);
    const mine = inRow(row);
    const column = mine.indexOf(target);
    /** The button of the same column in `other` (the last one where it has fewer). */
    const alongside = (other: HTMLElement | undefined) => {
      const there = inRow(other);
      return there[Math.min(column, there.length - 1)];
    };
    const at = rows.indexOf(row);
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowDown') next = alongside(rows[at + 1]);
    else if (e.key === 'ArrowUp') next = alongside(rows[at - 1]);
    else if (e.key === 'Home') next = alongside(rows[0]);
    else if (e.key === 'End') next = alongside(rows[rows.length - 1]);
    else if (e.key === 'ArrowRight') next = mine[column + 1];
    else if (e.key === 'ArrowLeft') next = mine[column - 1];
    else return;
    // Handled, also at the end of the list: mpv does not get the arrow too.
    e.preventDefault();
    next?.focus();
  };

  const statusText =
    announcement !== ''
      ? announcement
      : !searching
        ? ''
        : visible.length === 0
          ? t('settings.shortcuts.search.none', { query: query.trim() })
          : t('settings.search.found', { total: visible.length });

  const problem =
    bindings === null
      ? readFailed
        ? 'settings.shortcuts.readFailed'
        : null
      : readFailed
        ? 'settings.shortcuts.refreshFailed'
        : bindings.length === 0
          ? 'settings.shortcuts.notReady'
          : null;

  return (
    <div ref={root} className={styles.page}>
      <p className={styles.intro}>{t('settings.shortcuts.intro')}</p>
      <div role="search" className={styles.searchBox}>
        <input
          type="search"
          className={styles.search}
          value={query}
          aria-label={t('settings.shortcuts.search.label')}
          placeholder={t('settings.shortcuts.search.label')}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setAnnouncement('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query !== '') {
              // Handled: the search is cleared, and Esc does not go on to mpv (fullscreen).
              e.preventDefault();
              setQuery('');
            }
          }}
        />
      </div>
      <p role="status" className={styles.status}>
        {statusText}
      </p>
      {bindings === null && problem === null && <p className={styles.loading}>{t('settings.loading')}</p>}
      {problem !== null && (
        <div role="alert" className={styles.failure}>
          <p className={styles.failureText}>{t(problem)}</p>
          <button
            type="button"
            className={styles.retry}
            onClick={() => {
              void read();
            }}
            {...blurAfterPointer}
          >
            {t('settings.retry')}
          </button>
        </div>
      )}
      <div onFocus={onListFocus} onKeyDown={onListKeyDown}>
        {groups.map((group) => {
          const headingId = `shortcuts-group-${group.id}`;
          return (
            <section key={group.id} aria-labelledby={headingId} className={styles.group}>
              <h3 id={headingId} className={styles.groupHeading}>
                {sourceLabel(group.source)}
              </h3>
              <ul className={styles.list}>
                {group.bindings.map((binding) => {
                  const { key } = binding;
                  const silenced = isSilenced(binding);
                  const waiting = capturing === key;
                  const asked = conflict?.from === key ? conflict : null;
                  const error = errors[key];
                  return (
                    <li
                      key={key}
                      className={styles.row}
                      data-binding={key}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape' && asked !== null) {
                          // Handled: the question is dropped, and Esc does not go on to mpv.
                          e.preventDefault();
                          setConflict(null);
                        }
                      }}
                    >
                      <kbd className={styles.key}>{key}</kbd>
                      <div className={styles.what}>
                        {silenced ? (
                          <span className={styles.disabled}>{t('settings.shortcuts.disabled')}</span>
                        ) : (
                          <>
                            <span className={styles.name} title={binding.comment ?? binding.command}>
                              {binding.comment ?? displayCommand(binding.command)}
                            </span>
                            {binding.comment !== null && (
                              <code className={styles.command} title={binding.command}>
                                {displayCommand(binding.command)}
                              </code>
                            )}
                          </>
                        )}
                      </div>
                      <div className={styles.actions}>
                        {!silenced && (
                          <button
                            type="button"
                            className={styles.action}
                            data-rove-id={changeId(key)}
                            tabIndex={entry === changeId(key) ? 0 : -1}
                            aria-label={t('settings.shortcuts.changeLabel', { key })}
                            aria-pressed={waiting}
                            disabled={busy === key}
                            onClick={() => {
                              if (waiting) {
                                setCapturing(null);
                                setNote(null);
                              } else {
                                setConflict(null);
                                setNote(null);
                                withoutError(key);
                                setCapturing(key);
                              }
                            }}
                            {...blurAfterPointer}
                          >
                            {t('settings.shortcuts.change')}
                          </button>
                        )}
                        <button
                          type="button"
                          className={styles.action}
                          data-rove-id={resetId(key)}
                          tabIndex={entry === resetId(key) ? 0 : -1}
                          aria-label={t('settings.shortcuts.resetLabel', { key })}
                          disabled={busy === key}
                          onClick={() => {
                            setCapturing(null);
                            void reset(key);
                          }}
                          {...blurAfterPointer}
                        >
                          {t('settings.shortcuts.reset')}
                        </button>
                      </div>
                      {waiting && (
                        <div className={styles.extra}>
                          <p role="status" className={styles.hint}>
                            {t('settings.shortcuts.waiting', { key })}
                            {note !== null && ` ${t(note)}`}
                          </p>
                          <button
                            type="button"
                            className={styles.action}
                            onClick={() => {
                              setCapturing(null);
                              setNote(null);
                            }}
                            {...blurAfterPointer}
                          >
                            {t('settings.shortcuts.cancel')}
                          </button>
                        </div>
                      )}
                      {asked !== null && (
                        <div className={styles.extra}>
                          <p role="alert" className={styles.hint}>
                            {t('settings.shortcuts.conflict', {
                              key: asked.to,
                              command: asked.taken.comment ?? displayCommand(asked.taken.command),
                            })}
                          </p>
                          <button
                            type="button"
                            className={styles.action}
                            onClick={() => {
                              void rebind(asked.from, asked.to);
                            }}
                            {...blurAfterPointer}
                          >
                            {t('settings.shortcuts.replace')}
                          </button>
                          <button
                            type="button"
                            className={styles.action}
                            onClick={() => {
                              setConflict(null);
                            }}
                            {...blurAfterPointer}
                          >
                            {t('settings.shortcuts.cancel')}
                          </button>
                        </div>
                      )}
                      {error !== undefined && (
                        <p role="alert" className={styles.error}>
                          {t(error)}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
