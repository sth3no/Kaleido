import { describe, expect, it } from 'vitest';
import { applyProp, badgeFor, formatTime, initialState } from './playerState';

describe('applyProp', () => {
  it('maps observed mpv properties onto UI state', () => {
    let s = applyProp(initialState, 'pause', false);
    s = applyProp(s, 'time-pos', 12.5);
    s = applyProp(s, 'osd-dimensions/ml', 140);
    s = applyProp(s, 'media-title', 'Duna');
    expect(s).toMatchObject({ pause: false, timePos: 12.5, title: 'Duna', osd: { ml: 140 } });
  });

  it('treats unavailable values as empty', () => {
    expect(applyProp(initialState, 'duration', null).duration).toBe(0);
    expect(applyProp(initialState, 'media-title', null).title).toBe('');
  });

  it('ignores unknown properties', () => {
    expect(applyProp(initialState, 'whatever', 1)).toBe(initialState);
  });
});

describe('badgeFor', () => {
  it('labels 4K HDR', () => expect(badgeFor({ gamma: 'pq', videoHeight: 2160 })).toBe('4K HDR'));
  it('labels HLG as HDR', () => expect(badgeFor({ gamma: 'hlg', videoHeight: 1080 })).toBe('1080p HDR'));
  it('has no badge for small SDR', () => expect(badgeFor({ gamma: 'bt.1886', videoHeight: 720 })).toBeUndefined());
});

describe('formatTime', () => {
  it.each([
    [0, '0:00'],
    [75.4, '1:15'],
    [3725, '1:02:05'],
    [Number.NaN, '0:00'],
    [-3, '0:00'],
  ])('%s → %s', (sec, text) => expect(formatTime(sec)).toBe(text));
});
