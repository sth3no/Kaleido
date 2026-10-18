/**
 * The tracks of one kind as a list to choose from (quick settings): a listbox whose options are the
 * tracks, and where asked an option at the end that turns the kind off. The chosen one is marked.
 *
 * The arrows, Home and End move the focus through the list (and say so with `preventDefault`, so
 * that mpv does not also get them); Enter and Space choose, as a click does. The focus does not
 * choose on the way: a track change reloads the subtitles, and an arrow held down would do it for
 * every step. The chosen option is the one Tab reaches, and the one the panel opens on.
 */

import { useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Track } from '../ipc/types';
import Icon, { CHECK } from '../shell/Icon';
import styles from './Panel.module.css';
import { trackLabel } from './trackName';

export interface TrackListProps {
  /** What the list is called, for screen readers. */
  label: string;
  tracks: readonly Track[];
  /** The id of the track that plays; `null` for none. */
  selected: number | null;
  /** The text of an option at the end that turns the kind off; left out, there is none. */
  offLabel?: string;
  /** `null` for the option that turns the kind off. */
  onSelect: (id: number | null) => void;
}

interface Option {
  key: string;
  id: number | null;
  name: string;
  detail: string;
}

export default function TrackList({ label, tracks, selected, offLabel, onSelect }: TrackListProps) {
  const { t, i18n } = useTranslation();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const options: Option[] = tracks.map((track) => ({
    key: `track-${String(track.id)}`,
    id: track.id,
    ...trackLabel(track, t, i18n.language),
  }));
  if (offLabel !== undefined) options.push({ key: 'off', id: null, name: offLabel, detail: '' });

  const chosen = options.findIndex((option) => option.id === selected);
  // What Tab reaches and the panel opens on: the chosen option, or the first.
  const entry = Math.max(0, chosen);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = buttons.current.findIndex((button) => button !== null && button === document.activeElement);
    if (index < 0 || e.ctrlKey || e.altKey || e.metaKey) return;
    const last = options.length - 1;
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(index + 1, last);
    else if (e.key === 'ArrowUp') next = Math.max(index - 1, 0);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next < 0) return;
    // Handled here: mpv does not get the arrow too.
    e.preventDefault();
    buttons.current[next]?.focus();
  };

  return (
    <div role="listbox" aria-label={label} className={styles.options} onKeyDown={onKeyDown}>
      {options.map((option, index) => {
        const isChosen = index === chosen;
        return (
          <button
            key={option.key}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="option"
            className={styles.option}
            aria-selected={isChosen}
            tabIndex={index === entry ? 0 : -1}
            data-autofocus={index === entry ? '' : undefined}
            onClick={() => {
              onSelect(option.id);
            }}
          >
            <span className={styles.text}>
              <span className={styles.name}>{option.name}</span>
              {option.detail !== '' && <span className={styles.detail}>{option.detail}</span>}
            </span>
            {isChosen && <Icon path={CHECK} />}
          </button>
        );
      })}
    </div>
  );
}
