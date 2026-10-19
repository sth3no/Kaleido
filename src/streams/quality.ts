/**
 * The qualities of a link to choose from (spec 8.5, point 2; plan decision 9): "Automatic" first,
 * then one choice for each height that has a picture, the tallest first, and "Audio only" last if
 * the link has a format with a sound and no picture. They are made from the formats yt-dlp lists
 * (`yt-dlp -J`, which Rust runs while the link loads), the way the downloader reads them
 * (`formats.ts`); a live stream has the same list.
 *
 * A choice is a `ytdl-format` that Rust gives to mpv for the link: for a height
 * `bv*[height<=?H]+ba/b[height<=?H]` (the best picture up to H with the best sound, and where the
 * link has no separate streams the best file up to H), for the sound alone `ba/b`. "Automatic" has
 * no selector (`null`): the link plays in the default quality of the settings. Each choice passes
 * the check of a format that Rust makes (`LoadOptions::validate`).
 *
 * The label of a height says what the choice will most likely be: the format yt-dlp ranks first at
 * that height, as the selector takes the best one up to it. `1080p`, `1080p60` above 30 frames a
 * second, and ` HDR` for any dynamic range but SDR.
 */

import type { TFunction } from 'i18next';

import type { StreamInfo } from '../ipc/types';
import { getVideoFormats, hasAudioOnlyFormat } from './formats';

export interface QualityOption {
  /** Tells the choices of one list apart: `auto`, `audio` or `h<height>`. */
  id: string;
  /** What the list says: `Automatic`, `1080p60 HDR`, `Audio only`. */
  label: string;
  /** The `ytdl-format` to play with; `null` for the default quality. */
  selector: string | null;
  /** The height of the picture; `null` for the others. */
  height: number | null;
  fps: number | null;
  hdr: boolean;
  audioOnly: boolean;
}

/** The sound alone: the best audio, or the best file where the link has no separate audio. */
export const AUDIO_ONLY_SELECTOR = 'ba/b';

/** The best picture and sound up to `height`. */
export const heightSelector = (height: number): string =>
  `bv*[height<=?${height}]+ba/b[height<=?${height}]`;

/** Frames a second above which the label says them. */
const SMOOTH_FPS = 30;

/** Anything but SDR (`HDR10`, `HLG`, ...) is HDR. */
const isHdr = (dynamicRange: string | null): boolean =>
  dynamicRange !== null && dynamicRange.trim() !== '' && dynamicRange.trim().toUpperCase() !== 'SDR';

/** `1080p`, `1080p60`, `2160p60 HDR`. */
function heightLabel(height: number, fps: number | null, hdr: boolean): string {
  const smooth = fps !== null && fps > SMOOTH_FPS ? String(Math.round(fps)) : '';
  return `${height}p${smooth}${hdr ? ' HDR' : ''}`;
}

/**
 * The choices for a link, in the order to show them: Automatic, the heights from the tallest, Audio
 * only. A format without a height (a picture yt-dlp does not measure) has no height to select by
 * and is left out.
 */
export function qualityOptions(info: StreamInfo, t: TFunction): QualityOption[] {
  const options: QualityOption[] = [
    {
      id: 'auto',
      label: t('panels.quality.auto'),
      selector: null,
      height: null,
      fps: null,
      hdr: false,
      audioOnly: false,
    },
  ];

  // Best first, so the first format found at a height is the best one at it.
  const heights = new Map<number, QualityOption>();
  for (const format of getVideoFormats(info)) {
    const { height } = format;
    if (height === null || !Number.isInteger(height) || height <= 0 || heights.has(height)) continue;
    const hdr = isHdr(format.dynamicRange);
    heights.set(height, {
      id: `h${height}`,
      label: heightLabel(height, format.fps, hdr),
      selector: heightSelector(height),
      height,
      fps: format.fps,
      hdr,
      audioOnly: false,
    });
  }
  options.push(...[...heights.values()].sort((a, b) => (b.height ?? 0) - (a.height ?? 0)));

  if (hasAudioOnlyFormat(info)) {
    options.push({
      id: 'audio',
      label: t('panels.quality.audioOnly'),
      selector: AUDIO_ONLY_SELECTOR,
      height: null,
      fps: null,
      hdr: false,
      audioOnly: true,
    });
  }
  return options;
}

const HEIGHT_IN_SELECTOR = /height<=\?(\d+)/;

/**
 * The short text of the quality chosen for a link, for the button of the controls: `Auto`,
 * `1080p`, `Audio`. It reads the height from the selector, so it needs neither the list nor the
 * answer of yt-dlp; a selector it does not know (Kaleido makes only the ones above) is `Auto`.
 */
export function shortQualityLabel(chosen: string | null, t: TFunction): string {
  if (chosen === AUDIO_ONLY_SELECTOR) return t('panels.quality.audioShort');
  const height = chosen === null ? undefined : HEIGHT_IN_SELECTOR.exec(chosen)?.[1];
  return height === undefined ? t('panels.quality.autoShort') : `${height}p`;
}
