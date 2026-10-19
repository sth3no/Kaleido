/*
 * Taken from The Downloader (src/lib/video-format.ts), by the same author, under its license:
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
 * Not taken over: `composeVideoFormat`. It adds `#<container>` (the downloader's merge container or
 * audio target), which is no part of a yt-dlp format selector and which `ytdl-format` would refuse.
 * Kaleido's own list of qualities is `quality.ts`; its selectors are not these.
 */

/**
 * Map a generic video-quality token (the `videoQuality` preference) to a
 * yt-dlp `-f` format selector string for the given output `container`. Any
 * unrecognised quality token resolves to the uncapped best-quality selector.
 *
 * For `mp4` the selector prefers H.264 (avc1) video + AAC (m4a) audio so the
 * chosen streams remux losslessly into a QuickTime-playable mp4 (no re-encode).
 * The filter is on the *codec*, not the container: YouTube ships AV1 and VP9 at
 * the top resolutions (AV1 even inside an mp4 box), and neither plays reliably
 * in QuickTime — so `[ext=mp4]` is not enough, it must be `[vcodec^=avc1]`.
 * H.264 caps at 1080p on YouTube, the accepted tradeoff for "an mp4 that always
 * opens". Other containers impose no codec constraint, so `--merge-output-format`
 * alone sets the box around the best available streams.
 */
export function videoFormatSelector(quality: string, container: string): string {
  const cap = quality === '1080' || quality === '720' || quality === '480' ? `[height<=${quality}]` : '';
  const stem = quality === 'smallest' ? 'worst' : 'best';
  const v = `${stem}video${cap}`;
  const a = `${stem}audio`;
  if (container === 'mp4') {
    // H.264+AAC first, then a progressive H.264 file, then any best streams.
    return `${v}[vcodec^=avc1]+${a}[ext=m4a]/${stem}${cap}[vcodec^=avc1]/${v}+${a}/${stem}${cap}`;
  }
  return `${v}+${a}/${stem}${cap}`;
}
