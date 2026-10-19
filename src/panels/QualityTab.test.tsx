import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../i18n';
import { attachVideoInput } from '../input/forward';
import type { StreamError, StreamFormat, StreamFormats, StreamInfo } from '../ipc/types';
import { usePlayerStore } from '../state/playerStore';
import { AUDIO_ONLY_SELECTOR, heightSelector } from '../streams/quality';
import { useStreamStore } from '../streams/streamStore';
import QualityTab from './QualityTab';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

const LINK = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const P1080 = heightSelector(1080);
const P720 = heightSelector(720);

const picture = (height: number, over: Partial<StreamFormat> = {}): StreamFormat => ({
  formatId: String(height),
  ext: 'mp4',
  height,
  width: Math.round((height * 16) / 9),
  fps: 30,
  vcodec: 'avc1',
  acodec: null,
  dynamicRange: 'SDR',
  tbr: null,
  filesize: null,
  filesizeApprox: null,
  protocol: 'https',
  ...over,
});

const sound: StreamFormat = {
  formatId: '140',
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
};

/** As yt-dlp lists them, the worst first. */
const INFO: StreamInfo = {
  title: 'Big Buck Bunny',
  duration: 634.5,
  live: false,
  formats: [
    sound,
    picture(720),
    picture(1080, { fps: 60 }),
    picture(2160, { fps: 60, dynamicRange: 'HDR10' }),
  ],
};

const ready = (chosen: string | null = null, info: StreamInfo = INFO): StreamFormats => ({
  url: LINK,
  state: { type: 'ready', info },
  chosen,
});

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  useStreamStore.setState(useStreamStore.getInitialState(), true);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A link plays, `formats` is what is known of it, and the tab is shown. */
function open(formats: StreamFormats | null) {
  usePlayerStore.setState({
    loaded: true,
    props: { 'idle-active': false, pause: false, path: LINK },
  });
  useStreamStore.setState({ formats });
  return render(<QualityTab />);
}

/** Rust says something of the link (`stream:formats`). */
const hear = (formats: StreamFormats) => {
  act(() => {
    useStreamStore.getState().apply(formats);
  });
};

const radio = (name: string | RegExp) => screen.getByRole('radio', { name });

/** What was sent to the player as a quality. */
const qualities = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([name]) => name === 'player_set_quality')
    .map(([, args]) => (args as { format: string | null }).format);

/** What was passed on to mpv. */
const forwarded = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'player_input');

describe('the qualities', () => {
  test('are a radio group of one choice per height, the best first, with Automatic at the top', () => {
    open(ready());
    const group = screen.getByRole('radiogroup', { name: 'Available qualities' });
    const names = within(group)
      .getAllByRole('radio')
      .map((one) => one.querySelector('span > span')?.textContent);
    expect(names).toEqual(['Automatic', '2160p60 HDR', '1080p60', '720p', 'Audio only']);
  });

  test('Automatic says what it is, and is the one marked while nothing is chosen', () => {
    open(ready(null));
    expect(radio(/^Automatic/).getAttribute('aria-checked')).toBe('true');
    expect(radio(/^Automatic/).textContent).toContain('The default quality from Settings');
    expect(radio('1080p60').getAttribute('aria-checked')).toBe('false');
    expect(radio('720p').getAttribute('aria-checked')).toBe('false');
  });

  test('the one marked is the one Rust chose', () => {
    open(ready(P1080));
    expect(radio('1080p60').getAttribute('aria-checked')).toBe('true');
    expect(radio(/^Automatic/).getAttribute('aria-checked')).toBe('false');
    expect(radio('720p').getAttribute('aria-checked')).toBe('false');
  });

  test('a choice that is none of them marks none, and a click on any still works', () => {
    open(ready('bv*[height<=?1440]+ba/b[height<=?1440]'));
    expect(screen.getAllByRole('radio').filter((one) => one.getAttribute('aria-checked') === 'true')).toEqual([]);
    // Tab reaches the first one then.
    expect((radio(/^Automatic/) as HTMLButtonElement).tabIndex).toBe(0);
    fireEvent.click(radio('720p'));
    expect(qualities()).toEqual([P720]);
  });

  test('audio only is there when the stream has a format of sound alone, and not otherwise', () => {
    const { unmount } = open(ready());
    fireEvent.click(radio('Audio only'));
    expect(qualities()).toEqual([AUDIO_ONLY_SELECTOR]);
    unmount();

    open(ready(null, { ...INFO, formats: INFO.formats.filter((format) => format.vcodec !== null) }));
    expect(screen.queryByRole('radio', { name: 'Audio only' })).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
  });

  test('a live stream has the same list', () => {
    open(ready(null, { ...INFO, live: true, duration: null }));
    expect(screen.getAllByRole('radio')).toHaveLength(5);
  });

  test('a stream that lists nothing has Automatic alone, and says so', () => {
    const { unmount } = open(ready(null, { ...INFO, formats: [] }));
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(screen.getByText('yt-dlp lists no other qualities for this link.')).toBeTruthy();
    unmount();

    // With more to choose from there is nothing to explain.
    open(ready());
    expect(screen.queryByText('yt-dlp lists no other qualities for this link.')).toBeNull();
  });

  test('the texts follow the language', () => {
    setLanguage('cs');
    try {
      open(ready());
      expect(screen.getByRole('radiogroup', { name: 'Dostupné kvality' })).toBeTruthy();
      expect(radio(/^Automaticky/)).toBeTruthy();
      expect(radio('Jen zvuk')).toBeTruthy();
    } finally {
      setLanguage('en');
    }
  });
});

describe('choosing', () => {
  test('choosing a height sends its selector and marks it chosen', () => {
    open(ready());
    fireEvent.click(radio('1080p60'));
    expect(qualities()).toEqual([P1080]);

    // Rust's word is what is marked.
    expect(radio('1080p60').getAttribute('aria-checked')).toBe('false');
    hear(ready(P1080));
    expect(radio('1080p60').getAttribute('aria-checked')).toBe('true');
    expect(radio(/^Automatic/).getAttribute('aria-checked')).toBe('false');
  });

  test('Automatic sends the default quality: no selector', () => {
    open(ready(P720));
    fireEvent.click(radio(/^Automatic/));
    expect(qualities()).toEqual([null]);
    hear(ready(null));
    expect(radio(/^Automatic/).getAttribute('aria-checked')).toBe('true');
    expect(radio('720p').getAttribute('aria-checked')).toBe('false');
  });

  test('a choice is at work until Rust says it, and the list says so', () => {
    open(ready());
    expect(screen.getByRole('status').textContent).toBe('');

    fireEvent.click(radio('720p'));
    expect(radio('720p').getAttribute('aria-busy')).toBe('true');
    expect(radio('1080p60').hasAttribute('aria-busy')).toBe(false);
    expect(radio(/^Automatic/).hasAttribute('aria-busy')).toBe(false);
    expect(screen.getByRole('status').textContent).toBe('Switching the quality…');

    // The probe told again with the quality as it was changes nothing about the wait.
    hear(ready());
    expect(radio('720p').getAttribute('aria-busy')).toBe('true');

    hear(ready(P720));
    expect(radio('720p').hasAttribute('aria-busy')).toBe(false);
    expect(radio('720p').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('');
  });

  test('a choice that Rust never confirms is not at work for ever', () => {
    vi.useFakeTimers();
    open(ready());
    fireEvent.click(radio('720p'));
    expect(radio('720p').getAttribute('aria-busy')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(radio('720p').hasAttribute('aria-busy')).toBe(false);
    expect(radio(/^Automatic/).getAttribute('aria-checked')).toBe('true');
  });

  test('the quality that is marked is not sent again', () => {
    open(ready(P1080));
    fireEvent.click(radio('1080p60'));
    expect(qualities()).toEqual([]);
    expect(radio('1080p60').hasAttribute('aria-busy')).toBe(false);
  });

  test('a refused choice is not left at work', async () => {
    vi.mocked(invoke).mockRejectedValueOnce('notAStream');
    open(ready());
    fireEvent.click(radio('720p'));
    await waitFor(() => {
      expect(radio('720p').hasAttribute('aria-busy')).toBe(false);
    });
  });
});

describe('before the qualities are there', () => {
  test('loading and a failed probe are shown in the tab: nothing known yet', () => {
    open(null);
    expect(screen.getByRole('status').textContent).toBe('Loading the qualities…');
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  test('loading and a failed probe are shown in the tab: yt-dlp is asked', () => {
    open({ url: LINK, state: { type: 'loading' }, chosen: null });
    expect(screen.getByRole('status').textContent).toBe('Loading the qualities…');
    expect(screen.queryByRole('radiogroup')).toBeNull();

    // The answer replaces the wait.
    hear(ready());
    expect(screen.queryByText('Loading the qualities…')).toBeNull();
    expect(screen.getByRole('radiogroup')).toBeTruthy();
  });

  test.each<[StreamError, string]>([
    ['outdated', 'yt-dlp no longer understands this website. A newer yt-dlp may.'],
    [
      'missing',
      'yt-dlp, the tool that reads web links, is not installed yet or could not be downloaded.',
    ],
    ['cookies', 'The cookies of the chosen browser could not be read.'],
    ['signIn', 'This website requires you to sign in.'],
    [
      'ageRestricted',
      'This video is age-restricted, and the website requires you to sign in to watch it.',
    ],
    ['geoBlocked', 'This video is not available in your region.'],
    ['private', 'This video is private.'],
    ['removed', 'This video was removed or no longer exists.'],
    ['network', 'yt-dlp could not reach the website. Check your internet connection.'],
  ])('loading and a failed probe are shown in the tab: %s', (error, text) => {
    open({
      url: LINK,
      state: { type: 'failed', error, message: 'ERROR: [youtube] aqz-KE-bpKQ: something yt-dlp wrote' },
      chosen: null,
    });
    expect(screen.getByText('The qualities of this link could not be loaded.')).toBeTruthy();
    expect(screen.getByText(text)).toBeTruthy();
    // A class explains itself: yt-dlp's own line is for a failure that has none.
    expect(screen.queryByText(/something yt-dlp wrote/)).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  test('loading and a failed probe are shown in the tab: a failure without a class shows yt-dlp’s line', () => {
    open({ url: LINK, state: { type: 'failed', error: null, message: 'yt-dlp took too long' }, chosen: null });
    expect(screen.getByText('The qualities of this link could not be loaded.')).toBeTruthy();
    expect(screen.getByText('yt-dlp, the tool that reads web links, could not say why.')).toBeTruthy();
    expect(screen.getByText('yt-dlp took too long')).toBeTruthy();
  });

  test('a failure without a class and without a line shows no empty one', () => {
    open({ url: LINK, state: { type: 'failed', error: null, message: '  ' }, chosen: null });
    expect(screen.getByText('yt-dlp, the tool that reads web links, could not say why.')).toBeTruthy();
    expect(document.querySelectorAll('p')).toHaveLength(2);
  });

  test('the state of another link is not shown', () => {
    open({ ...ready(P1080), url: 'https://www.twitch.tv/kaleido' });
    expect(screen.getByRole('status').textContent).toBe('Loading the qualities…');
  });

  test('every class of error has its words in both languages', () => {
    const classes: StreamError[] = [
      'outdated',
      'missing',
      'cookies',
      'signIn',
      'ageRestricted',
      'geoBlocked',
      'private',
      'removed',
      'network',
    ];
    const seen = new Set<string>();
    for (const language of ['en', 'cs'] as const) {
      setLanguage(language);
      try {
        for (const error of classes) {
          const { unmount } = open({
            url: LINK,
            state: { type: 'failed', error, message: '' },
            chosen: null,
          });
          const text = document.querySelectorAll('p')[1]?.textContent ?? '';
          expect(text, `${language}: ${error}`).not.toMatch(/^errors\./);
          expect(text, `${language}: ${error}`).not.toBe('');
          seen.add(`${language}:${text}`);
          unmount();
        }
      } finally {
        setLanguage('en');
      }
    }
    // Eighteen different sentences: nine classes, two languages.
    expect(seen.size).toBe(18);
  });
});

describe('the keyboard', () => {
  test('the marked choice is the one Tab reaches and the panel opens on', () => {
    open(ready(P1080));
    expect((radio('1080p60') as HTMLButtonElement).tabIndex).toBe(0);
    expect((radio(/^Automatic/) as HTMLButtonElement).tabIndex).toBe(-1);
    expect((radio('720p') as HTMLButtonElement).tabIndex).toBe(-1);
    expect(radio('1080p60').hasAttribute('data-autofocus')).toBe(true);
    expect(radio('720p').hasAttribute('data-autofocus')).toBe(false);
  });

  test('the arrows, Home and End move the focus and do not reach mpv, and choose nothing', () => {
    const detach = attachVideoInput(document.createElement('div'));
    try {
      open(ready(P1080));
      const auto = radio(/^Automatic/);
      const top = radio('2160p60 HDR');
      const p1080 = radio('1080p60');
      const p720 = radio('720p');
      const audio = radio('Audio only');
      p1080.focus();

      expect(fireEvent.keyDown(p1080, { key: 'ArrowDown', code: 'ArrowDown' })).toBe(false);
      expect(document.activeElement).toBe(p720);
      fireEvent.keyDown(p720, { key: 'ArrowDown', code: 'ArrowDown' });
      expect(document.activeElement).toBe(audio);
      // The ends hold: the arrow is handled all the same.
      expect(fireEvent.keyDown(audio, { key: 'ArrowDown', code: 'ArrowDown' })).toBe(false);
      expect(document.activeElement).toBe(audio);
      fireEvent.keyDown(audio, { key: 'ArrowUp', code: 'ArrowUp' });
      expect(document.activeElement).toBe(p720);
      fireEvent.keyDown(p720, { key: 'Home', code: 'Home' });
      expect(document.activeElement).toBe(auto);
      expect(fireEvent.keyDown(auto, { key: 'ArrowUp', code: 'ArrowUp' })).toBe(false);
      expect(document.activeElement).toBe(auto);
      fireEvent.keyDown(auto, { key: 'End', code: 'End' });
      expect(document.activeElement).toBe(audio);
      fireEvent.keyDown(audio, { key: 'ArrowUp', code: 'ArrowUp' });
      fireEvent.keyDown(p720, { key: 'ArrowUp', code: 'ArrowUp' });
      fireEvent.keyDown(p1080, { key: 'ArrowUp', code: 'ArrowUp' });
      expect(document.activeElement).toBe(top);

      // The focus moving chooses nothing, and mpv hears none of it.
      expect(qualities()).toEqual([]);
      expect(forwarded()).toEqual([]);
    } finally {
      detach();
    }
  });
});
