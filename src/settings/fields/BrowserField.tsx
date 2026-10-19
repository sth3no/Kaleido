/**
 * The browser whose cookies yt-dlp takes for links (`playback.cookiesFromBrowser`, spec 10.3, plan
 * decision 13): "Do not use", then the browsers Rust finds on this PC (`system_browsers`), read when the
 * field shows. The value is the `spec` that is saved (`BROWSER` or `BROWSER:PROFILE`), `''` for none.
 * The list opens in the page (see `Dropdown`) and is ordered as the chooser of the error card orders it:
 * Firefox and its forks first, then the Chromium browsers, each with the sentence Rust's warning stands
 * for (yt-dlp mostly cannot read their cookies on Windows, and the link then fails as a whole), then the
 * entries without a profile, which are shown with their sentence and cannot be chosen: an entry with an
 * empty `spec` is never saved.
 *
 * - Under the field, the sentence about the browser that is chosen stays (the Chromium warning), so
 *   that it is read without opening the list.
 * - A saved choice no browser found has (a profile that is gone, a browser that was removed) is shown as
 *   it is, chosen, with a note, and it stays until the user changes it: nothing here rewrites it.
 * - A list that cannot be read is said under the field with a way to read it again; "Do not use" still
 *   works then, to get out of a choice that does not.
 */

import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { systemBrowsers } from '../../ipc/commands';
import type { Browser } from '../../ipc/types';
import { isUnusable, noteKeyOf, orderBrowsers } from '../../shell/notices/browsers';
import Dropdown, { type DropdownOption } from './Dropdown';
import type { FieldProps } from './FieldProps';
import styles from './Fields.module.css';
import ListError from './ListError';
import { useRustList } from './useRustList';

/** Starts the value of an entry that cannot be chosen: it has no spec of its own, and no spec starts with `#`. */
const NO_PROFILE = '#no-profile:';

export default function BrowserField({ describedBy, ...props }: FieldProps<string>) {
  const { t } = useTranslation();
  const noteId = useId();
  const { items: found, failed, retry } = useRustList<Browser>(systemBrowsers, 'system_browsers');
  const { value } = props;

  const browsers = useMemo(() => (found === null ? null : orderBrowsers(found)), [found]);
  /** The browser the saved value is, if the list has it. */
  const chosen = browsers?.find((browser) => !isUnusable(browser) && browser.spec === value);
  /** Read, and the saved choice is not in it: the browser or its profile is gone. */
  const gone = browsers !== null && value !== '' && chosen === undefined;

  const options = useMemo<DropdownOption[]>(() => {
    const list: DropdownOption[] = [{ value: '', label: t('settings.fields.browser.none') }];
    for (const browser of browsers ?? []) {
      const noteKey = noteKeyOf(browser);
      const unusable = isUnusable(browser);
      list.push({
        value: unusable ? `${NO_PROFILE}${browser.id}` : browser.spec,
        label: browser.label,
        note: noteKey === null ? undefined : t(noteKey),
        disabled: unusable,
      });
    }
    if (gone) list.push({ value, label: value, note: t('settings.fields.browser.gone') });
    return list;
  }, [browsers, gone, value, t]);

  // The sentence under the field: about the browser chosen, else about the list.
  const note = gone
    ? 'settings.fields.browser.gone'
    : chosen !== undefined
      ? noteKeyOf(chosen)
      : browsers !== null && browsers.length === 0
        ? 'errors.browser.empty'
        : null;

  const described = [describedBy, note === null ? undefined : noteId]
    .filter((id): id is string => id !== undefined && id !== '')
    .join(' ');

  return (
    <>
      <Dropdown
        {...props}
        describedBy={described === '' ? undefined : described}
        // Not for changing while the list is on its way; a list that failed still has "Do not use".
        disabled={props.disabled === true || (found === null && !failed)}
        options={options}
      />
      {note !== null && (
        <p id={noteId} className={styles.note}>
          {t(note)}
        </p>
      )}
      {failed && <ListError onRetry={retry} />}
    </>
  );
}
