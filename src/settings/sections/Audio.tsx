/**
 * Audio (spec 8.10): the output device, the default and the maximum volume and the preferred
 * languages (`alang`). The default volume applies from the next start (its row says so): the
 * volume that is playing must not jump (Ruling R25).
 */

import type { SectionId } from '../descriptors';
import SettingsList, { type SectionProps } from './SettingsList';

const SECTION: SectionId = 'audio';

export default function Audio({ only }: SectionProps) {
  return <SettingsList section={SECTION} only={only} />;
}
