import type { PropValue } from './player';

export type PlayerState = {
  loaded: boolean;
  pause: boolean;
  timePos: number;
  duration: number;
  volume: number;
  fullscreen: boolean;
  title: string;
  gamma: string;
  videoHeight: number;
  osd: { w: number; h: number; ml: number; mt: number };
};

export const initialState: PlayerState = {
  loaded: false,
  pause: true,
  timePos: 0,
  duration: 0,
  volume: 100,
  fullscreen: false,
  title: '',
  gamma: '',
  videoHeight: 0,
  osd: { w: 0, h: 0, ml: 0, mt: 0 },
};

/** Applies one observed mpv property to the UI state. */
export function applyProp(s: PlayerState, name: string, v: PropValue): PlayerState {
  const num = typeof v === 'number' ? v : 0;
  const text = typeof v === 'string' ? v : '';
  switch (name) {
    case 'pause': return { ...s, pause: v === true };
    case 'time-pos': return { ...s, timePos: num };
    case 'duration': return { ...s, duration: num };
    case 'volume': return { ...s, volume: num };
    case 'fullscreen': return { ...s, fullscreen: v === true };
    case 'media-title': return { ...s, title: text };
    case 'video-params/gamma': return { ...s, gamma: text };
    case 'video-params/h': return { ...s, videoHeight: num };
    case 'osd-dimensions/w': return { ...s, osd: { ...s.osd, w: num } };
    case 'osd-dimensions/h': return { ...s, osd: { ...s.osd, h: num } };
    case 'osd-dimensions/ml': return { ...s, osd: { ...s.osd, ml: num } };
    case 'osd-dimensions/mt': return { ...s, osd: { ...s.osd, mt: num } };
    default: return s;
  }
}

/** Resolution/HDR label for the top-left capsule (spec 8.4). */
export function badgeFor(s: Pick<PlayerState, 'gamma' | 'videoHeight'>): string | undefined {
  const parts: string[] = [];
  if (s.videoHeight >= 2160) parts.push('4K');
  else if (s.videoHeight >= 1440) parts.push('1440p');
  else if (s.videoHeight >= 1080) parts.push('1080p');
  if (s.gamma === 'pq' || s.gamma === 'hlg') parts.push('HDR');
  return parts.length > 0 ? parts.join(' ') : undefined;
}

export function formatTime(sec: number): string {
  const total = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
