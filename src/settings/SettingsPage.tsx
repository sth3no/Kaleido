/**
 * The settings (spec 8.10), a page beside the docked sidebar:
 *
 * - A list of the sections (Playback, Subtitles, Audio, Video, Appearance, Shortcuts, About) and a
 *   search field. The list is navigated with the arrows (Home and End too; one item is the one Tab
 *   reaches, the one that had the focus last). Enter or Space opens a section, and the focus goes
 *   to its heading, so that a keyboard or screen reader user starts reading at the section. The keys
 *   it handles say so with `preventDefault`, so that mpv does not also get them.
 * - The section that is open, as rows (`SettingRow`) on a glass card. Every setting is saved as soon
 *   as it is changed, and what Rust refuses is said at the setting (`useSetting`).
 * - The search (`searchSettings`) replaces the section with the settings that match, grouped under
 *   their sections (and no section is the current one meanwhile); Esc in the field clears it, the
 *   down arrow or Enter in it goes into the results (to the control of the first), and Esc in a result
 *   (that has no list or typed text to close) comes back to the field. Typing in the field does not
 *   reach mpv (input/forward.ts leaves the keys of a text field alone).
 *
 * The values come from Rust when the page opens (`store.ts`), and Kaleido's own settings follow
 * `settings:changed`, so that a change made elsewhere shows here. A row is not drawn until its own
 * source has answered (Kaleido's settings are read; Rust has values for the mpv options, which it does
 * not while the player is not up): no row shows a fallback for a value, and the page says why rows are
 * missing and offers to read again. The search counts and enters only the rows that are drawn.
 *
 * Appearance, Shortcuts and About are in the list but have no body yet (Task 23): `BODIES` is
 * where they are added, and their descriptors go in `descriptors.ts`.
 *
 * The top of a docked page is the window's title bar (a drag strip over it), so nothing of the page
 * is there. While a video plays, the mini player is in the corner and the shell clips the page
 * around it: the card keeps room at its end (`--settings-mini-reserve`) so that the last rows can be
 * scrolled clear of the video. The lists of the fields open in the page, never in a layer of their
 * own (see `fields/Dropdown.tsx`).
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';

import { blurAfterPointer } from '../input/forward';
import { onSettingsChanged } from '../ipc/events';
import { listenTo } from '../ipc/listen';
import { MINI } from '../surface/mini';
import glass from '../theme/glass.module.css';
import { SECTIONS, type SectionId } from './descriptors';
import { searchSettings } from './search';
import Audio from './sections/Audio';
import Playback from './sections/Playback';
import type { SectionProps } from './sections/SettingsList';
import Subtitles from './sections/Subtitles';
import Video from './sections/Video';
import styles from './SettingsPage.module.css';
import { isLoaded, useSettingsStore, useSourcesLoaded } from './store';

/** What the first control of a result is found by (the ones that can take the focus now). */
const CONTROLS = 'button:not(:disabled), input:not(:disabled)';

/** The body of each section; a section with none shows its heading alone (Task 23 fills them in). */
const BODIES: Partial<Record<SectionId, ComponentType<SectionProps>>> = {
  playback: Playback,
  subtitles: Subtitles,
  audio: Audio,
  video: Video,
};

interface SectionViewProps {
  id: SectionId;
  /** Only these settings of it (a search); left out, all of them. */
  only?: ReadonlySet<string>;
  /** The heading is where the focus goes when the section is opened. */
  headingRef?: Ref<HTMLHeadingElement>;
}

function SectionView({ id, only, headingRef }: SectionViewProps) {
  const { t } = useTranslation();
  const headingId = `settings-section-${id}`;
  const Body = BODIES[id];
  return (
    <section aria-labelledby={headingId} className={styles.section}>
      <h2 id={headingId} ref={headingRef} tabIndex={-1} className={styles.heading}>
        {t(`settings.sections.${id}`)}
      </h2>
      {Body && <Body only={only} />}
    </section>
  );
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const status = useSettingsStore((state) => state.status);
  const [section, setSection] = useState<SectionId>(SECTIONS[0]);
  /** The item of the list that Tab reaches: the one that had the focus last. */
  const [rover, setRover] = useState<SectionId>(SECTIONS[0]);
  const [query, setQuery] = useState('');
  /** Counts the requests to move the focus to the open section's heading. */
  const [headingFocus, setHeadingFocus] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const items = useRef<Partial<Record<SectionId, HTMLButtonElement | null>>>({});
  const searchField = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const sources = useSourcesLoaded();

  // Subscribed before the values are read: a change in between is not lost.
  useEffect(
    () =>
      listenTo(
        onSettingsChanged,
        (settings) => {
          useSettingsStore.getState().setKaleido(settings);
        },
        'settings:changed',
      ),
    [],
  );
  useEffect(() => {
    void useSettingsStore.getState().load();
  }, []);

  // After the section is drawn: the focus goes to its heading.
  useEffect(() => {
    if (headingFocus > 0) heading.current?.focus();
  }, [headingFocus]);

  const searching = query.trim() !== '';
  const matches = useMemo(() => (searching ? searchSettings(query, t) : null), [searching, query, t]);
  /** The matches that are on the page: a setting whose source has not answered has no row (yet). */
  const shown = useMemo(
    () => (matches === null ? null : matches.filter((match) => isLoaded(sources, match.target))),
    [matches, sources],
  );
  /** The sections that have a row to show, each with the ids of its matches. */
  const groups = useMemo(
    () =>
      shown === null
        ? null
        : SECTIONS.map((id) => ({
            id,
            only: new Set(shown.filter((match) => match.section === id).map((match) => match.id)),
          })).filter((group) => group.only.size > 0),
    [shown],
  );

  const open = (id: SectionId) => {
    setSection(id);
    setRover(id);
    setQuery('');
    setHeadingFocus((count) => count + 1);
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const index = SECTIONS.findIndex((id) => items.current[id] === document.activeElement);
    if (index < 0) return;
    const last = SECTIONS.length - 1;
    let next = -1;
    if (e.key === 'ArrowDown') next = index === last ? 0 : index + 1;
    else if (e.key === 'ArrowUp') next = index === 0 ? last : index - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next < 0) return;
    // Handled here: mpv does not get the arrow too.
    e.preventDefault();
    items.current[SECTIONS[next]]?.focus();
  };

  /**
   * Down arrow or Enter in the search field: into the results, to the control of the first row that has
   * one. Says whether it went anywhere (the rows that are drawn are the ones that matched and have
   * their values).
   */
  const enterResults = (): boolean => {
    for (const row of card.current?.querySelectorAll('[data-setting]') ?? []) {
      const control = row.querySelector<HTMLElement>(CONTROLS);
      if (control) {
        control.focus();
        return true;
      }
    }
    return false;
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && query !== '') {
      // Handled: the search is cleared, and Esc does not go on to mpv (fullscreen).
      e.preventDefault();
      setQuery('');
    } else if (
      (e.key === 'ArrowDown' || e.key === 'Enter') &&
      !e.nativeEvent.isComposing &&
      enterResults()
    ) {
      // Handled, once the focus is in a result: mpv does not get the arrow. With nothing to go into
      // the key is not the field's.
      e.preventDefault();
    }
  };

  /** Esc in a result that has nothing to close (an open list or a typed text take it first): back to the field. */
  const onCardKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !searching || e.defaultPrevented) return;
    e.preventDefault();
    searchField.current?.focus();
  };

  const notRead =
    status === 'failed'
      ? 'settings.loadFailed'
      : status === 'ready' && !sources.mpv
        ? 'settings.playerNotReady'
        : null;

  // The count is of the rows on the page. Matches whose rows wait for their values are not counted,
  // and are not "no match" either: the banner (or the read still on its way) says why they are not there.
  const statusText =
    matches === null
      ? ''
      : matches.length === 0
        ? t('settings.search.none', { query: query.trim() })
        : shown !== null && shown.length > 0
          ? t('settings.search.found', { total: shown.length })
          : '';

  return (
    <div
      className={styles.page}
      style={{ '--settings-mini-reserve': `${MINI.w}px` } as CSSProperties}
    >
      <header className={styles.header}>
        <h1 className={styles.title}>{t('settings.title')}</h1>
        <div role="search">
          <input
            ref={searchField}
            type="search"
            className={styles.search}
            value={query}
            aria-label={t('settings.search.label')}
            placeholder={t('settings.search.placeholder')}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            onKeyDown={onSearchKeyDown}
          />
        </div>
      </header>
      <div className={styles.layout}>
        <nav className={styles.nav} aria-label={t('settings.sections.label')} onKeyDown={onListKeyDown}>
          <ul className={styles.list}>
            {SECTIONS.map((id) => (
              <li key={id}>
                <button
                  ref={(element) => {
                    items.current[id] = element;
                  }}
                  type="button"
                  className={styles.item}
                  // While the search shows its results no section is the one that is shown.
                  aria-current={!searching && id === section ? 'true' : undefined}
                  tabIndex={id === rover ? 0 : -1}
                  onFocus={() => {
                    setRover(id);
                  }}
                  onClick={() => {
                    open(id);
                  }}
                  {...blurAfterPointer}
                >
                  {t(`settings.sections.${id}`)}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div
          ref={card}
          className={`${glass.glass} ${styles.content}`}
          aria-busy={status === 'loading'}
          onKeyDown={onCardKeyDown}
        >
          <p role="status" className={styles.status}>
            {statusText}
          </p>
          {notRead !== null && (
            <div role="alert" className={styles.failure}>
              <p className={styles.failureText}>{t(notRead)}</p>
              <button
                type="button"
                className={styles.retry}
                onClick={() => {
                  void useSettingsStore.getState().load();
                }}
                {...blurAfterPointer}
              >
                {t('settings.retry')}
              </button>
            </div>
          )}
          {groups === null ? (
            <SectionView id={section} headingRef={heading} />
          ) : (
            groups.map((group) => <SectionView key={group.id} id={group.id} only={group.only} />)
          )}
        </div>
      </div>
    </div>
  );
}
