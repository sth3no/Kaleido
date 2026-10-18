/**
 * Video (spec 8.10; the page calls it "Obraz" in Czech): deinterlacing, HDR tone mapping and peak
 * detection, the quality preset (`profile`, from the next start) and the shaders of the user's
 * shaders folder.
 */

import type { SectionId } from '../descriptors';
import SettingsList, { type SectionProps } from './SettingsList';

const SECTION: SectionId = 'video';

export default function Video({ only }: SectionProps) {
  return <SettingsList section={SECTION} only={only} />;
}
