/**
 * Playback (spec 8.10): hardware decoding (`hwdec`), the playlist made from the folder of the
 * file (`autocreate-playlist`), remembering the position (`save-position-on-quit`) and what a file
 * opened while another plays does (`playback.openWhilePlaying`, Kaleido's own setting).
 */

import type { SectionId } from '../descriptors';
import SettingsList, { type SectionProps } from './SettingsList';

const SECTION: SectionId = 'playback';

export default function Playback({ only }: SectionProps) {
  return <SettingsList section={SECTION} only={only} />;
}
