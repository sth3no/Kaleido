import i18next from 'i18next';
import { beforeAll, describe, expect, test } from 'vitest';

import { initI18n } from '../i18n';
import type { StreamFormat, StreamInfo } from '../ipc/types';
import { AUDIO_ONLY_SELECTOR, heightSelector, qualityOptions, shortQualityLabel } from './quality';

beforeAll(() => {
  // Both languages are in memory; a fixed `t` asks for one without switching the app's.
  initI18n('en');
});

const english = () => i18next.getFixedT('en');
const czech = () => i18next.getFixedT('cs');

/** A format with a picture and nothing else known; `over` changes it. */
const picture = (height: number, over: Partial<StreamFormat> = {}): StreamFormat => ({
  formatId: `v${String(height)}`,
  ext: 'mp4',
  height,
  width: Math.round((height * 16) / 9),
  fps: 30,
  vcodec: 'avc1.640028',
  acodec: null,
  dynamicRange: 'SDR',
  tbr: null,
  filesize: null,
  filesizeApprox: null,
  protocol: 'https',
  ...over,
});

/** A format with a sound and no picture. */
const sound = (over: Partial<StreamFormat> = {}): StreamFormat => ({
  formatId: 'a',
  ext: 'm4a',
  height: null,
  width: null,
  fps: null,
  vcodec: null,
  acodec: 'mp4a.40.2',
  dynamicRange: null,
  tbr: 129,
  filesize: null,
  filesizeApprox: null,
  protocol: 'https',
  ...over,
});

const info = (formats: StreamFormat[], over: Partial<StreamInfo> = {}): StreamInfo => ({
  title: 'Big Buck Bunny',
  duration: 634.5,
  live: false,
  formats,
  ...over,
});

/** As yt-dlp lists them: the worst first, a faster or HDR format of a height after the slower one. */
const YOUTUBE = info([
  sound({ formatId: '139', tbr: 49 }),
  sound({ formatId: '140' }),
  picture(144, { formatId: '160' }),
  picture(360, { formatId: '134' }),
  picture(480, { formatId: '135' }),
  picture(720, { formatId: '136' }),
  picture(720, { formatId: '298', fps: 60 }),
  picture(1080, { formatId: '137' }),
  picture(1080, { formatId: '299', fps: 60 }),
  picture(2160, { formatId: '337', fps: 59.94, vcodec: 'vp09.02.51.10.01.09.16.09.00', dynamicRange: 'HDR10' }),
]);

describe('qualityOptions', () => {
  test('quality options are one per height, best first, with fps and HDR in the label', () => {
    const options = qualityOptions(YOUTUBE, english());

    expect(options.map((option) => option.label)).toEqual([
      'Automatic',
      '2160p60 HDR',
      '1080p60',
      '720p60',
      '480p',
      '360p',
      '144p',
      'Audio only',
    ]);
    // One for each height: the two formats of 1080 and of 720 are one choice each.
    const heights = options.flatMap((option) => (option.height === null ? [] : [option.height]));
    expect(heights).toEqual([2160, 1080, 720, 480, 360, 144]);

    const top = options[1];
    expect(top).toMatchObject({
      id: 'h2160',
      selector: 'bv*[height<=?2160]+ba/b[height<=?2160]',
      height: 2160,
      fps: 59.94,
      hdr: true,
      audioOnly: false,
    });
    // The label says what the selector will most likely give: the best format of that height.
    expect(options[2]).toMatchObject({ height: 1080, fps: 60, hdr: false, selector: heightSelector(1080) });
  });

  test('the choices are in the order of the heights, whatever order yt-dlp lists them in', () => {
    const shuffled = info([picture(1080), picture(360), picture(720), picture(2160), picture(480)]);
    const heights = qualityOptions(shuffled, english()).map((option) => option.height);
    // Best-first within a height is yt-dlp's; across heights the choices are sorted.
    expect(heights).toEqual([null, 2160, 1080, 720, 480, 360]);
  });

  test('the frames and the dynamic range are said as the label does', () => {
    const label = (format: Partial<StreamFormat>) =>
      qualityOptions(info([picture(1080, format)]), english())[1]?.label;

    expect(label({ fps: 30 })).toBe('1080p');
    expect(label({ fps: 24 })).toBe('1080p');
    expect(label({ fps: null })).toBe('1080p');
    expect(label({ fps: 31 })).toBe('1080p31');
    expect(label({ fps: 50 })).toBe('1080p50');
    // NTSC rates are rounded to the number people say.
    expect(label({ fps: 59.94 })).toBe('1080p60');
    expect(label({ fps: 60, dynamicRange: 'HLG' })).toBe('1080p60 HDR');
    expect(label({ dynamicRange: 'HDR10' })).toBe('1080p HDR');
    expect(label({ dynamicRange: 'DV' })).toBe('1080p HDR');
    // SDR, and a range yt-dlp does not say, is no HDR.
    expect(label({ dynamicRange: 'SDR' })).toBe('1080p');
    expect(label({ dynamicRange: 'sdr' })).toBe('1080p');
    expect(label({ dynamicRange: null })).toBe('1080p');
    expect(label({ dynamicRange: '' })).toBe('1080p');
  });

  test('audio only appears only when the stream has an audio-only format', () => {
    const withSound = qualityOptions(info([sound(), picture(720)]), english());
    expect(withSound.map((option) => option.label)).toEqual(['Automatic', '720p', 'Audio only']);
    expect(withSound.at(-1)).toMatchObject({
      id: 'audio',
      selector: 'ba/b',
      height: null,
      fps: null,
      hdr: false,
      audioOnly: true,
    });
    expect(AUDIO_ONLY_SELECTOR).toBe('ba/b');

    // A picture that carries its sound is no audio-only format.
    const progressive = qualityOptions(
      info([picture(720, { acodec: 'mp4a.40.2' }), picture(360, { acodec: 'mp4a.40.2' })]),
      english(),
    );
    expect(progressive.map((option) => option.label)).toEqual(['Automatic', '720p', '360p']);
    expect(progressive.some((option) => option.audioOnly)).toBe(false);

    // Pictures without sound do not make one either.
    expect(qualityOptions(info([picture(720)]), english()).some((option) => option.audioOnly)).toBe(false);
  });

  test('Auto is first and stands for the default quality', () => {
    for (const formats of [YOUTUBE.formats, [], [sound()]]) {
      const [first] = qualityOptions(info(formats), english());
      expect(first).toEqual({
        id: 'auto',
        label: 'Automatic',
        // No selector: Rust plays the link in the default quality of the settings.
        selector: null,
        height: null,
        fps: null,
        hdr: false,
        audioOnly: false,
      });
    }
    // Only Auto has no selector.
    expect(qualityOptions(YOUTUBE, english()).filter((option) => option.selector === null)).toHaveLength(1);
  });

  test('a live stream has the same list, and one that lists nothing has Auto alone', () => {
    const live = qualityOptions({ ...YOUTUBE, duration: null, live: true }, english());
    expect(live).toEqual(qualityOptions(YOUTUBE, english()));

    const none = qualityOptions(info([], { duration: null, live: true }), english());
    expect(none.map((option) => option.label)).toEqual(['Automatic']);
  });

  test('a picture without a height has nothing to select by and is left out', () => {
    const odd = info([
      picture(720),
      picture(1080, { height: null, formatId: 'unmeasured' }),
      picture(480, { height: 0, formatId: 'zero' }),
      picture(480, { height: 480.5, formatId: 'fraction' }),
    ]);
    expect(qualityOptions(odd, english()).map((option) => option.label)).toEqual(['Automatic', '720p']);
  });

  test('a format that yt-dlp marks with the literal none has no picture', () => {
    const none = info([picture(720, { vcodec: 'none' }), sound({ acodec: 'none' })]);
    expect(qualityOptions(none, english()).map((option) => option.label)).toEqual(['Automatic']);
  });

  test('each id is its own, and each selector is one Rust passes on', () => {
    const options = qualityOptions(YOUTUBE, english());
    expect(new Set(options.map((option) => option.id)).size).toBe(options.length);
    // The characters and the length Rust's check of a format allows (player/load.rs).
    const allowed = /^[A-Za-z0-9_+\-/*[\]<>=!~^$?.:()]{1,200}$/;
    for (const option of options) {
      if (option.selector !== null) expect(option.selector, option.id).toMatch(allowed);
    }
  });

  test('the texts follow the language', () => {
    const labels = (t: ReturnType<typeof english>) =>
      qualityOptions(info([sound(), picture(720)]), t).map((option) => option.label);
    expect(labels(english())).toEqual(['Automatic', '720p', 'Audio only']);
    expect(labels(czech())).toEqual(['Automaticky', '720p', 'Jen zvuk']);
  });
});

describe('heightSelector', () => {
  test('is the best picture and sound up to the height, or a file up to it', () => {
    expect(heightSelector(1080)).toBe('bv*[height<=?1080]+ba/b[height<=?1080]');
    expect(heightSelector(144)).toBe('bv*[height<=?144]+ba/b[height<=?144]');
  });
});

describe('shortQualityLabel', () => {
  test('says Auto for the default, the height for a height and Audio for the sound', () => {
    expect(shortQualityLabel(null, english())).toBe('Auto');
    expect(shortQualityLabel(heightSelector(1080), english())).toBe('1080p');
    expect(shortQualityLabel(heightSelector(144), english())).toBe('144p');
    expect(shortQualityLabel(AUDIO_ONLY_SELECTOR, english())).toBe('Audio');
    expect(shortQualityLabel(AUDIO_ONLY_SELECTOR, czech())).toBe('Zvuk');
    expect(shortQualityLabel(null, czech())).toBe('Auto');
  });

  test('a selector Kaleido does not make is Auto', () => {
    expect(shortQualityLabel('bestvideo+bestaudio/best', english())).toBe('Auto');
    expect(shortQualityLabel('', english())).toBe('Auto');
  });
});
