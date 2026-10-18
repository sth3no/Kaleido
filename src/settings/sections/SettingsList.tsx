/**
 * The settings of one section as a list of rows. The sections of the page are made of it; the
 * search shows a section with only the rows that matched (`only`, their ids).
 *
 * A row is drawn once its own source has answered (`useSourcesLoaded`): Kaleido's settings once they
 * are read, the mpv options once Rust has their values. Until then (the first read, a read that failed,
 * a player that is not up yet) there is nothing to show, and a row with a fallback value, a slider at its
 * minimum or a list with nothing chosen, would pass for a value. The page says why.
 */

import { descriptorsOf, type SectionId } from '../descriptors';
import SettingRow, { type SettingRowProps, type Unavailable } from '../SettingRow';
import { isLoaded, useSourcesLoaded } from '../store';

/** What the body of a section takes. */
export interface SectionProps {
  /** Show only these settings (by id); left out, all of them. */
  only?: ReadonlySet<string>;
}

export interface SettingsListProps extends SectionProps {
  section: SectionId;
  /** The settings (by id) that are off here, with why. */
  unavailable?: Readonly<Record<string, Unavailable>>;
  /** A slider of a row shows a value now (see `SettingRow`). */
  onPreview?: SettingRowProps['onPreview'];
}

export default function SettingsList({ section, only, unavailable, onPreview }: SettingsListProps) {
  const sources = useSourcesLoaded();
  return (
    <div>
      {descriptorsOf(section)
        .filter((descriptor) => only === undefined || only.has(descriptor.id))
        .filter((descriptor) => isLoaded(sources, descriptor.target))
        .map((descriptor) => (
          <SettingRow
            key={descriptor.id}
            descriptor={descriptor}
            unavailable={unavailable?.[descriptor.id]}
            onPreview={onPreview}
          />
        ))}
    </div>
  );
}
