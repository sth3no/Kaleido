/**
 * The settings of one section as a list of rows. The sections of the page are made of it; the
 * search shows a section with only the rows that matched (`only`, their ids).
 */

import { descriptorsOf, type SectionId } from '../descriptors';
import SettingRow from '../SettingRow';

/** What the body of a section takes. */
export interface SectionProps {
  /** Show only these settings (by id); left out, all of them. */
  only?: ReadonlySet<string>;
}

export default function SettingsList({ section, only }: SectionProps & { section: SectionId }) {
  return (
    <div>
      {descriptorsOf(section)
        .filter((descriptor) => only === undefined || only.has(descriptor.id))
        .map((descriptor) => (
          <SettingRow key={descriptor.id} descriptor={descriptor} />
        ))}
    </div>
  );
}
