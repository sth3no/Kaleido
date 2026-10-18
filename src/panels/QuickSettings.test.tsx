import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n } from '../i18n';
import { attachVideoInput } from '../input/forward';
import type { Track } from '../ipc/types';
import { usePlayerStore, type PlayerProps } from '../state/playerStore';
import { useUiStore, type QuickTab } from '../state/uiStore';
import { clampDelay, stepDelay } from './DelayStepper';
import QuickSettings, {
  AUDIO_DELAY_STEP_S,
  clampSubScale,
  SUB_DELAY_STEP_S,
  SUB_SCALE,
} from './QuickSettings';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

const SUBTITLES: Track[] = [
  { id: 1, type: 'sub', lang: 'cs' },
  { id: 2, type: 'sub', lang: 'en', title: 'SDH' },
];

const SOUNDS: Track[] = [
  { id: 1, type: 'audio', lang: 'en', codec: 'ac3', 'demux-channel-count': 6 },
  { id: 2, type: 'audio', lang: 'cs', title: 'Commentary' },
];

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  // The glass measures on animation frames: none run here.
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The panel as ControlsIsland draws it: over a button, open on `tab`. */
function Host() {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} type="button">
        Anchor
      </button>
      <QuickSettings anchor={anchor} />
    </>
  );
}

/** A file with `props` playing, and quick settings open on `tab`. */
function open(props: PlayerProps = {}, tab: QuickTab = 'subtitles') {
  usePlayerStore.setState({
    loaded: true,
    props: { 'idle-active': false, pause: false, ...props },
  });
  useUiStore.setState({ panel: 'quick-settings', quickTab: tab });
  return render(<Host />);
}

/** The commands sent to the player, each call. */
const commands = (): Record<string, unknown>[] =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([name]) => name === 'player_command')
    .map(([, args]) => (args as { cmd: Record<string, unknown> }).cmd);

/** What was passed on to mpv. */
const forwarded = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'player_input');

const option = (name: string | RegExp) => screen.getByRole('option', { name });
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('subtitles', () => {
  test('selecting Off turns subtitles off', () => {
    open({ 'track-list': SUBTITLES, sid: 1 });
    fireEvent.click(option('Off'));
    expect(commands()).toEqual([{ type: 'selectTrack', kind: 'sub', id: null }]);
  });

  test('selecting a track selects it by its id', () => {
    open({ 'track-list': SUBTITLES, sid: 1 });
    fireEvent.click(option('English · SDH'));
    expect(commands()).toEqual([{ type: 'selectTrack', kind: 'sub', id: 2 }]);
  });

  test('the track that plays is marked, and Off when none does', () => {
    const { unmount } = open({ 'track-list': SUBTITLES, sid: 2 });
    expect(option('English · SDH').getAttribute('aria-selected')).toBe('true');
    expect(option('Czech').getAttribute('aria-selected')).toBe('false');
    expect(option('Off').getAttribute('aria-selected')).toBe('false');
    // The chosen one is the one Tab reaches and the panel opens on.
    expect((option('English · SDH') as HTMLButtonElement).tabIndex).toBe(0);
    expect((option('Czech') as HTMLButtonElement).tabIndex).toBe(-1);
    expect(document.activeElement).toBe(option('English · SDH'));
    unmount();

    // mpv's `no` arrives as null.
    open({ 'track-list': SUBTITLES, sid: null });
    expect(option('Off').getAttribute('aria-selected')).toBe('true');
    expect(option('Czech').getAttribute('aria-selected')).toBe('false');
  });

  test('before mpv reports sid, the track list says which track is selected', () => {
    open({ 'track-list': [{ ...SUBTITLES[0], selected: true }, SUBTITLES[1]] });
    expect(option('Czech').getAttribute('aria-selected')).toBe('true');
  });

  test('a subtitle file loaded from outside is named by its file where it says nothing itself', () => {
    open({
      'track-list': [
        ...SUBTITLES,
        { id: 3, type: 'sub', external: true, 'external-filename': 'C:\\Titulky\\film.cs.srt' },
      ],
      sid: 3,
    });
    const external = option(/^film\.cs\.srt/);
    expect(external.getAttribute('aria-selected')).toBe('true');
    expect(external.textContent).toContain('External file');
  });

  test('a file without subtitles says so, and still loads one', () => {
    open({ 'track-list': [] });
    expect(screen.getByText('This file has no subtitles')).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
    // The panel opens on the first thing Tab reaches: the tab.
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Subtitles' }));
    expect(button('Load from file…')).toBeTruthy();
  });

  test('load from file opens the dialog for a subtitle file', () => {
    open({ 'track-list': SUBTITLES, sid: 1 });
    fireEvent.click(button('Load from file…'));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('system_open_dialog', { purpose: 'subtitle' });
  });

  test('delay buttons step by 100 ms', () => {
    open({ 'sub-delay': 0.3 });
    const group = screen.getByRole('group', { name: 'Delay' });
    expect(group.textContent).toContain('+0.3 s');

    fireEvent.click(button('Increase by 0.1 s'));
    expect(commands()).toEqual([{ type: 'setSubDelay', seconds: 0.4 }]);
    expect(group.textContent).toContain('+0.4 s');

    // Pressed again before mpv has answered: another step from the value just set.
    fireEvent.click(button('Decrease by 0.1 s'));
    fireEvent.click(button('Decrease by 0.1 s'));
    expect(commands().slice(1)).toEqual([
      { type: 'setSubDelay', seconds: 0.3 },
      { type: 'setSubDelay', seconds: 0.2 },
    ]);
    expect(group.textContent).toContain('+0.2 s');

    // mpv's report takes over, and the next step goes from it.
    act(() => {
      usePlayerStore.getState().applyChanges({ 'sub-delay': 0.2 });
    });
    fireEvent.click(button('Increase by 0.1 s'));
    expect(commands().at(-1)).toEqual({ type: 'setSubDelay', seconds: 0.3 });
  });

  test('the delay goes below zero and shows its sign', () => {
    open({ 'sub-delay': 0 });
    const group = screen.getByRole('group', { name: 'Delay' });
    fireEvent.click(button('Decrease by 0.1 s'));
    expect(commands()).toEqual([{ type: 'setSubDelay', seconds: -0.1 }]);
    expect(group.textContent).toMatch(/[-−]0\.1 s/);
  });

  test('the size is a slider from 50 to 200 %', () => {
    open({ 'sub-scale': 1.25 });
    const slider = screen.getByRole('slider', { name: 'Size' }) as HTMLInputElement;
    expect(slider.min).toBe(String(SUB_SCALE.min));
    expect(slider.max).toBe(String(SUB_SCALE.max));
    expect(slider.getAttribute('aria-valuetext')).toBe('125%');

    fireEvent.change(slider, { target: { value: '1.5' } });
    expect(commands()).toEqual([{ type: 'setSubScale', scale: 1.5 }]);
    expect(slider.getAttribute('aria-valuetext')).toBe('150%');
  });

  test.each([
    ['3', 2],
    ['0.1', 0.5],
  ])('sub-scale is clamped to 0.5–2.0: %s is sent as %s', (typed, sent) => {
    open({ 'sub-scale': 1 });
    fireEvent.change(screen.getByRole('slider', { name: 'Size' }), { target: { value: typed } });
    expect(commands()).toEqual([{ type: 'setSubScale', scale: sent }]);
  });

  test('the size the slider was last moved to is sent when the panel closes', () => {
    const { unmount } = open({ 'sub-scale': 1 });
    const slider = screen.getByRole('slider', { name: 'Size' });

    // The first move goes at once; the second comes within the throttle's interval and is held back.
    fireEvent.change(slider, { target: { value: '1.5' } });
    fireEvent.change(slider, { target: { value: '1.75' } });
    expect(commands()).toEqual([{ type: 'setSubScale', scale: 1.5 }]);

    // The panel closes before the interval is over: what was held back goes now, it is not lost.
    unmount();
    expect(commands()).toEqual([
      { type: 'setSubScale', scale: 1.5 },
      { type: 'setSubScale', scale: 1.75 },
    ]);
  });

  test('the size readout is not a live region, the slider says its value itself', () => {
    open({ 'sub-scale': 1.25 });
    const readout = screen.getByText('125%');
    expect(readout.tagName).toBe('OUTPUT');
    expect(readout.getAttribute('aria-live')).toBe('off');
    expect(screen.getByRole('slider', { name: 'Size' }).getAttribute('aria-valuetext')).toBe('125%');
  });

  test('a size mpv reports outside the range is shown held to it', () => {
    open({ 'sub-scale': 3 });
    expect(screen.getByRole('slider', { name: 'Size' }).getAttribute('aria-valuetext')).toBe('200%');
  });
});

describe('audio', () => {
  test('lists the audio tracks with what tells them apart, and no Off', () => {
    open({ 'track-list': [...SUBTITLES, ...SOUNDS.map((track, i) => ({ ...track, id: i + 1 }))], aid: 1 }, 'audio');
    expect(screen.getByRole('listbox', { name: 'Audio tracks' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Off' })).toBeNull();
    // Only the audio tracks, not the subtitles.
    expect(screen.getAllByRole('option')).toHaveLength(2);
    const english = option(/^English/);
    expect(english.getAttribute('aria-selected')).toBe('true');
    expect(english.textContent).toContain('AC3 · 5.1');
    expect(option(/^Czech · Commentary/).getAttribute('aria-selected')).toBe('false');
  });

  test('selecting an audio track selects it by its id', () => {
    open({ 'track-list': SOUNDS, aid: 1 }, 'audio');
    fireEvent.click(option(/^Czech/));
    expect(commands()).toEqual([{ type: 'selectTrack', kind: 'audio', id: 2 }]);
  });

  test('audio delay steps by 50 ms', () => {
    open({ 'audio-delay': 0 }, 'audio');
    const group = screen.getByRole('group', { name: 'Delay' });

    fireEvent.click(button('Increase by 0.05 s'));
    fireEvent.click(button('Increase by 0.05 s'));
    expect(commands()).toEqual([
      { type: 'setAudioDelay', seconds: 0.05 },
      { type: 'setAudioDelay', seconds: 0.1 },
    ]);
    expect(group.textContent).toContain('+0.1 s');

    fireEvent.click(button('Decrease by 0.05 s'));
    fireEvent.click(button('Decrease by 0.05 s'));
    fireEvent.click(button('Decrease by 0.05 s'));
    expect(commands().slice(2)).toEqual([
      { type: 'setAudioDelay', seconds: 0.05 },
      { type: 'setAudioDelay', seconds: 0 },
      { type: 'setAudioDelay', seconds: -0.05 },
    ]);
    expect(group.textContent).toMatch(/[-−]0\.05 s/);
  });

  test('a file without audio says so', () => {
    open({ 'track-list': SUBTITLES }, 'audio');
    expect(screen.getByText('This file has no audio tracks')).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('tabs', () => {
  test('the open tab is the one Tab reaches, and a click switches', () => {
    open({ 'track-list': SUBTITLES, sid: 1 });
    const subtitles = screen.getByRole('tab', { name: 'Subtitles' }) as HTMLButtonElement;
    const audio = screen.getByRole('tab', { name: 'Audio' }) as HTMLButtonElement;
    expect(subtitles.getAttribute('aria-selected')).toBe('true');
    expect(subtitles.tabIndex).toBe(0);
    expect(audio.tabIndex).toBe(-1);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(subtitles.id);

    fireEvent.click(audio);
    expect(useUiStore.getState().quickTab).toBe('audio');
    expect(audio.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(audio.id);
    expect(screen.queryByRole('option', { name: 'Off' })).toBeNull();
  });

  test('the arrows, Home and End move between the tabs and do not reach mpv', () => {
    const detach = attachVideoInput(document.createElement('div'));
    try {
      open({ 'track-list': SUBTITLES, sid: 1 });
      const subtitles = screen.getByRole('tab', { name: 'Subtitles' });
      const audio = screen.getByRole('tab', { name: 'Audio' });
      subtitles.focus();

      expect(fireEvent.keyDown(subtitles, { key: 'ArrowRight', code: 'ArrowRight' })).toBe(false);
      expect(useUiStore.getState().quickTab).toBe('audio');
      expect(document.activeElement).toBe(audio);

      // Round: the right arrow on the last tab goes to the first.
      expect(fireEvent.keyDown(audio, { key: 'ArrowRight', code: 'ArrowRight' })).toBe(false);
      expect(useUiStore.getState().quickTab).toBe('subtitles');
      expect(document.activeElement).toBe(subtitles);

      expect(fireEvent.keyDown(subtitles, { key: 'ArrowLeft', code: 'ArrowLeft' })).toBe(false);
      expect(useUiStore.getState().quickTab).toBe('audio');
      fireEvent.keyDown(audio, { key: 'Home', code: 'Home' });
      expect(useUiStore.getState().quickTab).toBe('subtitles');
      fireEvent.keyDown(subtitles, { key: 'End', code: 'End' });
      expect(useUiStore.getState().quickTab).toBe('audio');
      expect(document.activeElement).toBe(audio);
      expect(forwarded()).toEqual([]);
    } finally {
      detach();
    }
  });
});

describe('the track list', () => {
  test('the arrows, Home and End move the focus and do not reach mpv', () => {
    const detach = attachVideoInput(document.createElement('div'));
    try {
      open({ 'track-list': SUBTITLES, sid: 1 });
      const czech = option('Czech');
      const english = option('English · SDH');
      const off = option('Off');
      expect(document.activeElement).toBe(czech);

      expect(fireEvent.keyDown(czech, { key: 'ArrowDown', code: 'ArrowDown' })).toBe(false);
      expect(document.activeElement).toBe(english);
      fireEvent.keyDown(english, { key: 'ArrowDown', code: 'ArrowDown' });
      expect(document.activeElement).toBe(off);
      // The ends hold: the arrow is handled all the same.
      expect(fireEvent.keyDown(off, { key: 'ArrowDown', code: 'ArrowDown' })).toBe(false);
      expect(document.activeElement).toBe(off);
      fireEvent.keyDown(off, { key: 'ArrowUp', code: 'ArrowUp' });
      expect(document.activeElement).toBe(english);
      fireEvent.keyDown(english, { key: 'Home', code: 'Home' });
      expect(document.activeElement).toBe(czech);
      expect(fireEvent.keyDown(czech, { key: 'ArrowUp', code: 'ArrowUp' })).toBe(false);
      expect(document.activeElement).toBe(czech);
      fireEvent.keyDown(czech, { key: 'End', code: 'End' });
      expect(document.activeElement).toBe(off);

      // The focus moving chooses nothing.
      expect(commands()).toEqual([]);
      expect(forwarded()).toEqual([]);
    } finally {
      detach();
    }
  });
});

describe('limits', () => {
  test('clampSubScale holds the size to 50–200 % and to hundredths', () => {
    expect(clampSubScale(0.1)).toBe(0.5);
    expect(clampSubScale(3)).toBe(2);
    expect(clampSubScale(0.5)).toBe(0.5);
    expect(clampSubScale(2)).toBe(2);
    expect(clampSubScale(1.2345)).toBe(1.23);
    expect(clampSubScale(-4)).toBe(0.5);
  });

  test('the steps are 0.1 s for subtitles and 0.05 s for audio', () => {
    expect(SUB_DELAY_STEP_S).toBe(0.1);
    expect(AUDIO_DELAY_STEP_S).toBe(0.05);
  });

  test('stepDelay adds a step without drifting and stays within ±600 s', () => {
    expect(stepDelay(0.3, 1, 0.1)).toBe(0.4);
    expect(stepDelay(0.3, -1, 0.1)).toBe(0.2);
    expect(stepDelay(0.1, 1, 0.05)).toBe(0.15);
    // Ten steps of 0.1 s are exactly one second.
    let seconds = 0;
    for (let step = 0; step < 10; step += 1) seconds = stepDelay(seconds, 1, 0.1);
    expect(seconds).toBe(1);
    expect(stepDelay(599.95, 1, 0.1)).toBe(600);
    expect(stepDelay(-600, -1, 0.05)).toBe(-600);
    expect(clampDelay(1e9)).toBe(600);
    expect(clampDelay(-1e9)).toBe(-600);
  });
});
