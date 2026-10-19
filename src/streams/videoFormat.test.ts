/*
 * Taken from The Downloader (tests/video-format.test.ts), by the same author, under its license:
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
 * Not taken over: the tests of `composeVideoFormat`, which is not taken over either (see
 * videoFormat.ts).
 */

import { describe, expect, it } from 'vitest';

import { videoFormatSelector } from './videoFormat';

describe('videoFormatSelector', () => {
  // For mp4 we steer yt-dlp toward H.264 (avc1) video + AAC (m4a) audio so the
  // streams remux losslessly into a QuickTime-playable mp4 (no re-encode). The
  // filter is on the *codec*, not the container: YouTube ships AV1 inside mp4
  // too, and AV1 won't reliably play in QuickTime — so [ext=mp4] is not enough,
  // it must be [vcodec^=avc1]. H.264 caps at 1080p on YouTube, the accepted
  // tradeoff for "an mp4 that always opens".
  describe('mp4 container — prefers H.264/AAC by codec, with progressive fallbacks', () => {
    it("maps 'best' to an avc1-preferring selector ending in a best-anything fallback", () => {
      expect(videoFormatSelector('best', 'mp4')).toBe(
        'bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/best[vcodec^=avc1]/bestvideo+bestaudio/best',
      );
    });

    it('applies the height cap to every alternative in the mp4 selector', () => {
      expect(videoFormatSelector('1080', 'mp4')).toBe(
        'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=1080][vcodec^=avc1]/bestvideo[height<=1080]+bestaudio/best[height<=1080]',
      );
    });

    it("maps 'smallest' to a worst-quality avc1-preferring selector", () => {
      expect(videoFormatSelector('smallest', 'mp4')).toBe(
        'worstvideo[vcodec^=avc1]+worstaudio[ext=m4a]/worst[vcodec^=avc1]/worstvideo+worstaudio/worst',
      );
    });
  });

  // Non-mp4 containers (mkv, webm) impose no codec constraint, so we keep the
  // simple best-streams selector and let --merge-output-format set the box.
  describe('non-mp4 containers — codec-agnostic best streams', () => {
    it("maps 'best' to an uncapped selector", () => {
      expect(videoFormatSelector('best', 'mkv')).toBe('bestvideo+bestaudio/best');
    });

    it("maps '1080' to a 1080-capped selector", () => {
      expect(videoFormatSelector('1080', 'webm')).toBe(
        'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
      );
    });

    it("maps 'smallest' to a worst-quality selector", () => {
      expect(videoFormatSelector('smallest', 'mkv')).toBe('worstvideo+worstaudio/worst');
    });

    it('falls back to the uncapped selector for an unrecognised quality token', () => {
      expect(videoFormatSelector('360', 'mkv')).toBe('bestvideo+bestaudio/best');
    });
  });
});
