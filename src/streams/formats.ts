/*
 * `formatTbr`, `formatFilesize` and `getVideoFormats` are taken from The Downloader (src/utils.ts),
 * by the same author, under its license; the types are Kaleido's `StreamFormat` (camelCase):
 *
 * MIT License
 *
 * Copyright (c) 2021 Raycast
 * Copyright (c) 2026 Vojtěch Stehlík
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * The formats of a link as yt-dlp lists them (`StreamInfo.formats`, worst first): which of them
 * have a picture or a sound, and how a bitrate and a size are written. `quality.ts` makes the list
 * of qualities from them.
 */

import type { StreamFormat, StreamInfo } from '../ipc/types';

export function formatTbr(tbr: number | null) {
  if (!tbr) return '';
  return `${Math.floor(tbr)} kbps`;
}

export function formatFilesize(filesize?: number | null, filesizeApprox?: number | null) {
  const size = filesize || filesizeApprox;
  if (!size) return '';

  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 ** 2) {
    return `${(size / 1024).toFixed(2)} KiB`;
  }
  if (size < 1024 ** 3) {
    return `${(size / 1024 ** 2).toFixed(2)} MiB`;
  }
  return `${(size / 1024 ** 3).toFixed(2)} GiB`;
}

/**
 * A codec as Rust passes it (`StreamFormat.vcodec`): `null` for no such stream (yt-dlp's `none`,
 * which is also taken here should it ever come as it is), `''` for one yt-dlp does not know, else
 * its name.
 */
const isNone = (codec: string | null): boolean => codec === null || codec === 'none';

/**
 * The format has a picture: a video codec yt-dlp names, or one it does not know in a format with a
 * height (a plain HLS playlist without `CODECS` lists its heights all the same).
 */
export const hasVideo = ({ vcodec, height }: StreamFormat): boolean =>
  !isNone(vcodec) && (vcodec !== '' || height !== null);

/**
 * The format has a sound: an audio codec yt-dlp names, or one it does not know in a format that has
 * no picture.
 */
export const hasAudio = ({ acodec, vcodec }: StreamFormat): boolean =>
  !isNone(acodec) && (acodec !== '' || isNone(vcodec));

/**
 * The video formats from yt-dlp metadata, best-first (yt-dlp lists them
 * worst-first). Audio-only formats are excluded — the list of qualities wants a
 * video stream for each height; the audio-only choice is a selector of its own
 * (`quality.ts`), not a concrete format.
 */
export const getVideoFormats = (info?: StreamInfo | null): StreamFormat[] => {
  if (!info) return [];
  return info.formats
    .slice()
    .reverse()
    .filter((format) => hasVideo(format));
};

/** Whether the link has a format with a sound and no picture. */
export const hasAudioOnlyFormat = (info: StreamInfo): boolean =>
  info.formats.some((format) => hasAudio(format) && !hasVideo(format));
