/**
 * Subtitles (spec 8.10): the font, its size, the colours of the text, the outline and the
 * background, the width of the outline and the preferred languages (`slang`). All of them are mpv
 * options and apply to the subtitles on the screen at once.
 */

import type { SectionId } from '../descriptors';
import SettingsList, { type SectionProps } from './SettingsList';

const SECTION: SectionId = 'subtitles';

export default function Subtitles({ only }: SectionProps) {
  return <SettingsList section={SECTION} only={only} />;
}
