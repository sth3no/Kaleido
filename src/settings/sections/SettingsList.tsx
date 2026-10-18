/**
 * The settings of one section as a list of rows. The sections of the page are made of it; the
 * search shows a section with only the rows that matched (`only`, their ids).
 *
 * The mpv options are shown once Rust has their values: until then (the first read, or a player
 * that is not up yet) their rows are left out rather than drawn with a slider at its minimum and a
 * list with nothing chosen, which would look like values. The page says why.
 */

import { descriptorsOf, isMpvTarget, type SectionId } from '../descriptors';
import SettingRow from '../SettingRow';
import { useSettingsStore } from '../store';

/** What the body of a section takes. */
export interface SectionProps {
  /** Show only these settings (by id); left out, all of them. */
  only?: ReadonlySet<string>;
}

export default function SettingsList({ section, only }: SectionProps & { section: SectionId }) {
  const mpvLoaded = useSettingsStore((state) => state.mpvLoaded);
  return (
    <div>
      {descriptorsOf(section)
        .filter((descriptor) => only === undefined || only.has(descriptor.id))
        .filter((descriptor) => mpvLoaded || !isMpvTarget(descriptor.target))
        .map((descriptor) => (
          <SettingRow key={descriptor.id} descriptor={descriptor} />
        ))}
    </div>
  );
}
