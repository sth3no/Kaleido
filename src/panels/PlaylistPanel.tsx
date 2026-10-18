/**
 * The playlist (spec 8.4, 8.5 point 2): the panel over the playlist button with the entries of
 * mpv's playlist, the one that plays marked.
 *
 * - A click on an entry plays it (`PlaylistPlay`); ✕ takes it out (`PlaylistRemove`).
 * - An entry moves by its grip: the pointer is captured, a line shows where it would land, and the
 *   release moves it (`PlaylistMove`, `to` is the place it ends up at). Esc ends the drag without
 *   a move (and does not close the panel). The keyboard does the same without a pointer: Alt+↑ and
 *   Alt+↓ on an entry move it one place.
 * - The arrows, Home and End move the focus between the entries (`preventDefault`, so that mpv
 *   does not also get them). The entry that plays, or the one the focus was last on, is the one Tab
 *   reaches, with its ✕ beside it.
 * - After a move the focus stays on the entry that moved; after ✕ it goes to the entry that takes
 *   the place of the one removed, or to the one before when the last was removed.
 *
 * The rows are kept by their place, not by what is in them: mpv sends the playlist anew after a
 * move, and a row that moved in the page would lose the focus. The focus is put on the row where
 * the entry will be, and the entry is there when mpv's answer comes.
 *
 * Names are the entry's title, else its file name, else the host of a link (`entryName`).
 */

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

import { formatNumber } from '../i18n/format';
import { entryName } from '../player/entryName';
import Icon, { CLOSE, GRIP } from '../shell/Icon';
import { selectPlaylist, usePlayerStore } from '../state/playerStore';
import { useUiStore } from '../state/uiStore';
import { readZoomFrame, toWindowBox } from '../theme/zoom';
import styles from './PlaylistPanel.module.css';
import Popover from './Popover';
import { sendCommand } from './props';

/** A drag by the grip: the entry that moves, and the slot the pointer is at now. */
interface Drag {
  from: number;
  /** 0 for before the first entry, the length for after the last. */
  slot: number;
  pointerId: number;
}

/**
 * The place an entry ends up at when it is dropped in `slot` (the gap before entry `slot`; the
 * length of the list for after the last): taking it out of the list first moves the later slots up.
 * `from` itself means no move.
 */
export function moveTarget(from: number, slot: number): number {
  return slot > from ? slot - 1 : slot;
}

/** Which edge of row `position` the line of a drag in `slot` is drawn at, if either. */
function dropMark(slot: number, position: number, count: number): 'before' | 'after' | undefined {
  if (slot === position) return 'before';
  return slot === count && position === count - 1 ? 'after' : undefined;
}

export interface PlaylistPanelProps {
  /** The playlist button. */
  anchor: RefObject<HTMLElement | null>;
}

export default function PlaylistPanel({ anchor }: PlaylistPanelProps) {
  const { t } = useTranslation();
  const items = usePlayerStore((state) => selectPlaylist(state.props));
  const setPanel = useUiStore((state) => state.setPanel);
  const header = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLLIElement | null)[]>([]);
  /** The entry Tab reaches: the one the focus was last on. Until then, the one that plays. */
  const [active, setActive] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragging = drag !== null;

  const count = items.length;
  const playing = items.findIndex((item) => item.current);
  const entry = count === 0 ? -1 : Math.min(count - 1, Math.max(0, active ?? playing));

  /** mpv's index of the entry in row `position`. */
  const indexAt = (position: number): number => items[position]?.index ?? position;

  const focusRow = (position: number) => {
    rows.current[position]?.querySelector<HTMLElement>('[data-play]')?.focus();
  };

  const play = (index: number) => {
    sendCommand({ type: 'playlistPlay', index });
  };

  const move = (from: number, to: number) => {
    sendCommand({ type: 'playlistMove', from: indexAt(from), to: indexAt(to) });
    setActive(to);
    focusRow(to);
  };

  const remove = (position: number) => {
    sendCommand({ type: 'playlistRemove', index: indexAt(position) });
    // The next entry takes its place; for the last one, the one before is where the focus goes.
    const target = position < count - 1 ? position : position - 1;
    if (target < 0) {
      // Nothing left to focus: the panel itself keeps the focus.
      header.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
      return;
    }
    setActive(target);
    focusRow(target);
  };

  /** The gap the pointer is at: before the first row whose middle is below it, else after the last. */
  const slotAt = (clientY: number): number => {
    const frame = readZoomFrame();
    for (let position = 0; position < count; position += 1) {
      const row = rows.current[position];
      if (!row) continue;
      const box = toWindowBox(row.getBoundingClientRect(), frame);
      if (clientY < box.top + box.height / 2) return position;
    }
    return count;
  };

  // Esc in a drag ends the drag; it comes before the panel's own Esc, which would close the panel.
  useEffect(() => {
    if (!dragging) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setDrag(null);
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
    };
  }, [dragging]);

  const startDrag = (e: PointerEvent<HTMLElement>, position: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      // The moves and the release come here even when the pointer has left the grip.
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is gone already; the drag ends with the next event.
    }
    setActive(position);
    setDrag({ from: position, slot: slotAt(e.clientY), pointerId: e.pointerId });
  };

  const moveDrag = (e: PointerEvent<HTMLElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    // No button down any more: the release was never seen.
    if (e.buttons === 0) {
      setDrag(null);
      return;
    }
    const slot = slotAt(e.clientY);
    if (slot !== drag.slot) setDrag({ ...drag, slot });
  };

  const endDrag = (e: PointerEvent<HTMLElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const to = moveTarget(drag.from, slotAt(e.clientY));
    setDrag(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Not held any more.
    }
    if (to !== drag.from && drag.from < count) move(drag.from, to);
  };

  const cancelDrag = () => {
    setDrag(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (!(e.target instanceof Element) || e.ctrlKey || e.metaKey) return;
    const row = e.target.closest<HTMLElement>('[data-index]');
    if (!row) return;
    const position = Number(row.dataset['index']);
    if (e.altKey) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      // Handled here, at the ends too: mpv does not get Alt+arrow.
      e.preventDefault();
      const to = e.key === 'ArrowUp' ? position - 1 : position + 1;
      if (to >= 0 && to < count) move(position, to);
      return;
    }
    let next = -1;
    if (e.key === 'ArrowUp') next = Math.max(0, position - 1);
    else if (e.key === 'ArrowDown') next = Math.min(count - 1, position + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count - 1;
    if (next < 0) return;
    e.preventDefault();
    focusRow(next);
  };

  // The gap the line shows, where the dragged entry would land; none (-1) where it would stay.
  const lineSlot = drag && moveTarget(drag.from, drag.slot) !== drag.from ? drag.slot : -1;

  return (
    <Popover
      anchor={anchor}
      label={t('panels.playlist')}
      onClose={() => {
        setPanel(null);
      }}
      className={styles.playlist}
    >
      <div ref={header} className={styles.header}>
        <h2 className={styles.title}>{t('panels.playlist')}</h2>
        {playing >= 0 && (
          <span className={`${styles.position} tabular`}>
            {t('panels.playlistPosition', {
              position: formatNumber(playing + 1),
              total: formatNumber(count),
            })}
          </span>
        )}
      </div>
      {count === 0 ? (
        <p className={styles.empty}>{t('panels.playlistEmpty')}</p>
      ) : (
        <ul className={styles.list} onKeyDown={onKeyDown}>
          {items.map((item, position) => {
            const name = entryName(item);
            const here = position === entry;
            return (
              <li
                // By place: see the top of the file.
                key={position}
                ref={(element) => {
                  rows.current[position] = element;
                }}
                className={styles.row}
                data-index={position}
                data-current={item.current}
                data-dragging={drag?.from === position}
                data-drop={dropMark(lineSlot, position, count)}
                onFocus={() => {
                  setActive(position);
                }}
              >
                <span
                  className={styles.handle}
                  data-handle
                  title={t('panels.reorderHint')}
                  aria-hidden
                  onPointerDown={(e) => {
                    startDrag(e, position);
                  }}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={cancelDrag}
                  onLostPointerCapture={cancelDrag}
                >
                  <Icon path={GRIP} />
                </span>
                <button
                  type="button"
                  className={styles.play}
                  data-play
                  data-autofocus={here ? '' : undefined}
                  tabIndex={here ? 0 : -1}
                  aria-current={item.current ? 'true' : undefined}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  title={name}
                  onClick={() => {
                    play(item.index);
                  }}
                >
                  {name}
                </button>
                <button
                  type="button"
                  className={styles.remove}
                  tabIndex={here ? 0 : -1}
                  aria-label={t('panels.remove', { name })}
                  onClick={() => {
                    remove(position);
                  }}
                >
                  <Icon path={CLOSE} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Popover>
  );
}
