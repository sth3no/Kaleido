/*
 * The tests of `formatFilesize` and `getVideoFormats` are taken from The Downloader
 * (tests/utils.test.ts), by the same author, under its license; the types are Kaleido's
 * `StreamFormat` (camelCase). The rest is Kaleido's.
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
 */

import { describe, expect, it } from 'vitest';

import type { StreamFormat, StreamInfo } from '../ipc/types';
import {
  formatFilesize,
  formatTbr,
  getVideoFormats,
  hasAudio,
  hasAudioOnlyFormat,
  hasVideo,
} from './formats';

/** A format with a picture and a sound, and nothing else known; `over` changes it. */
const fmt = (over: Partial<StreamFormat>): StreamFormat => ({
  formatId: '0',
  ext: 'mp4',
  height: 1080,
  width: 1920,
  fps: null,
  vcodec: 'avc1',
  acodec: 'mp4a',
  dynamicRange: null,
  tbr: null,
  filesize: null,
  filesizeApprox: null,
  protocol: 'https',
  ...over,
});

const info = (formats: StreamFormat[]): StreamInfo => ({
  title: 't',
  duration: 1,
  live: false,
  formats,
});

describe('formatTbr', () => {
  it("returns '' for no bitrate", () => {
    expect(formatTbr(null)).toBe('');
    expect(formatTbr(0)).toBe('');
  });

  it('cuts the bitrate to whole kilobits', () => {
    expect(formatTbr(129.483)).toBe('129 kbps');
    expect(formatTbr(4500)).toBe('4500 kbps');
  });
});

describe('formatFilesize', () => {
  it("returns '' for falsy sizes", () => {
    expect(formatFilesize(undefined, undefined)).toBe('');
    expect(formatFilesize(0)).toBe('');
    // Rust says null for a size it does not know.
    expect(formatFilesize(null, null)).toBe('');
  });

  it('formats across unit boundaries', () => {
    expect(formatFilesize(512)).toBe('512 B');
    expect(formatFilesize(1536)).toBe('1.50 KiB');
    expect(formatFilesize(1024 ** 2 * 2)).toBe('2.00 MiB');
    expect(formatFilesize(1024 ** 3 * 3)).toBe('3.00 GiB');
  });

  it('falls back to the approximate size when exact is absent', () => {
    expect(formatFilesize(undefined, 2048)).toBe('2.00 KiB');
    expect(formatFilesize(null, 2048)).toBe('2.00 KiB');
  });
});

describe('getVideoFormats', () => {
  const video = info([
    fmt({ formatId: 'worst', height: 360 }),
    fmt({ formatId: 'audio', vcodec: null, height: null }),
    fmt({ formatId: 'best', height: 1080 }),
  ]);

  it('returns video formats best-first (yt-dlp lists worst-first) and drops audio-only entries', () => {
    expect(getVideoFormats(video).map((f) => f.formatId)).toEqual(['best', 'worst']);
  });

  it('does not reorder the list it was given', () => {
    getVideoFormats(video);
    expect(video.formats.map((f) => f.formatId)).toEqual(['worst', 'audio', 'best']);
  });

  it('returns an empty list when there is no metadata', () => {
    expect(getVideoFormats(undefined)).toEqual([]);
    expect(getVideoFormats(null)).toEqual([]);
  });

  it('takes the literal none of yt-dlp for no picture as well', () => {
    expect(getVideoFormats(info([fmt({ formatId: 'a', vcodec: 'none' })]))).toEqual([]);
  });
});

describe('what a format has', () => {
  it('a picture is a video codec, a sound an audio codec, and null or none is neither', () => {
    expect(hasVideo(fmt({ vcodec: 'vp09' }))).toBe(true);
    expect(hasVideo(fmt({ vcodec: null }))).toBe(false);
    expect(hasVideo(fmt({ vcodec: 'none' }))).toBe(false);
    expect(hasAudio(fmt({ acodec: 'opus' }))).toBe(true);
    expect(hasAudio(fmt({ acodec: null }))).toBe(false);
    expect(hasAudio(fmt({ acodec: 'none' }))).toBe(false);
  });

  it('a link has an audio-only format when one has a sound and no picture', () => {
    const picture = fmt({ vcodec: 'vp09', acodec: null });
    const sound = fmt({ vcodec: null, acodec: 'opus', height: null });
    expect(hasAudioOnlyFormat(info([picture, sound]))).toBe(true);
    expect(hasAudioOnlyFormat(info([picture]))).toBe(false);
    // A format with both is no audio-only one.
    expect(hasAudioOnlyFormat(info([fmt({})]))).toBe(false);
    expect(hasAudioOnlyFormat(info([]))).toBe(false);
  });
});
