import { invoke } from '@tauri-apps/api/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n, setLanguage } from '../../i18n';
import type { Browser } from '../../ipc/types';
import { useUiStore } from '../../state/uiStore';
import BrowserChooser, { orderBrowsers, type BrowserChooserProps } from './BrowserChooser';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const browser = (
  id: string,
  label: string,
  spec: string,
  warning: Browser['warning'] = null,
): Browser => ({ id, label, spec, warning });

const FIREFOX = browser('firefox', 'Firefox', 'firefox');
const EDGE = browser('edge', 'Microsoft Edge', 'edge', 'chromiumCookies');
const CHROME = browser('chrome', 'Google Chrome', 'chrome', 'chromiumCookies');
const LIBREWOLF = browser('librewolf', 'LibreWolf', 'firefox:abc123.default-release');
const ZEN = browser('zen', 'Zen', '', 'noProfile');
/** As Rust lists them: Firefox first, the Chromium browsers, then the forks of Firefox. */
const FOUND = [FIREFOX, EDGE, CHROME, LIBREWOLF, ZEN];

const NO_COOKIES = 'Do not use cookies';

beforeAll(() => {
  initI18n('en');
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useUiStore.setState(useUiStore.getInitialState(), true);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.mocked(console.warn).mockRestore();
  setLanguage('en');
});

/** How Rust answers `system_browsers`. */
function rustHas(browsers: Browser[]) {
  vi.mocked(invoke).mockImplementation((async (command: string) =>
    command === 'system_browsers' ? browsers : null) as unknown as typeof invoke);
}

/** The chooser, once Rust has listed the browsers. */
async function open(over: Partial<BrowserChooserProps> = {}, browsers: Browser[] = FOUND) {
  rustHas(browsers);
  const onUse = vi.fn<(spec: string | null) => void>();
  const props: BrowserChooserProps = { offerNone: false, busy: false, focusOnReady: false, onUse, ...over };
  const view = render(<BrowserChooser {...props} />);
  await waitFor(() => {
    expect(screen.queryByText('Looking for browsers…')).toBeNull();
  });
  return { onUse, props, ...view };
}

const radio = (name: string) => screen.getByRole('radio', { name });
const useButton = () => screen.getByRole('button', { name: 'Use and try again' });

/** The names of the rows, top to bottom. */
const names = () =>
  screen
    .getAllByRole('radio')
    .map((row) => document.getElementById(row.getAttribute('aria-labelledby') ?? '')?.textContent);

/** The sentence under a row's name, `null` where it has none. */
const noteOf = (name: string): string | null => {
  const id = radio(name).getAttribute('aria-describedby');
  return id === null ? null : (document.getElementById(id)?.textContent ?? null);
};

describe('orderBrowsers', () => {
  test('Firefox and its forks come first, the Chromium browsers after, the ones without a profile last', () => {
    expect(orderBrowsers(FOUND).map((item) => item.id)).toEqual([
      'firefox',
      'librewolf',
      'edge',
      'chrome',
      'zen',
    ]);
  });

  test('Rust\'s order is kept within each group, and the list it was given is not changed', () => {
    const list = [CHROME, EDGE, ZEN, FIREFOX];
    const before = [...list];

    expect(orderBrowsers(list).map((item) => item.id)).toEqual(['firefox', 'chrome', 'edge', 'zen']);
    expect(list).toEqual(before);
  });

  test('an entry with nothing to save goes last, whatever its warning says', () => {
    const odd = browser('arc', 'Arc', '', null);

    expect(orderBrowsers([odd, EDGE, FIREFOX]).map((item) => item.id)).toEqual(['firefox', 'edge', 'arc']);
  });
});

describe('the list', () => {
  test('is a radio group of the browsers Rust found, Firefox and its forks first', async () => {
    await open();

    const group = screen.getByRole('radiogroup', { name: 'Take cookies from' });
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(FOUND.length);
    expect(names()).toEqual(['Firefox', 'LibreWolf', 'Microsoft Edge', 'Google Chrome', 'Zen']);
  });

  test('says that it is looking, until Rust has answered', () => {
    vi.mocked(invoke).mockImplementation((() => new Promise(() => undefined)) as unknown as typeof invoke);

    render(<BrowserChooser offerNone busy={false} focusOnReady={false} onUse={() => undefined} />);

    expect(screen.getByRole('status').textContent).toBe('Looking for browsers…');
    // Not even "Do not use cookies" yet: the list comes in one piece.
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use and try again' })).toBeNull();
  });

  test('a Chromium browser carries the warning, Firefox and its forks carry none', async () => {
    await open();

    expect(noteOf('Firefox')).toBeNull();
    expect(noteOf('LibreWolf')).toBeNull();
    for (const name of ['Microsoft Edge', 'Google Chrome']) {
      expect(noteOf(name), name).toBe(
        'yt-dlp usually cannot read the cookies of browsers based on Chromium on Windows, and the link then fails as a whole. Firefox works.',
      );
    }
  });

  test('a browser without a profile says so, is shown and cannot be chosen', async () => {
    const { onUse } = await open();

    const zen = radio('Zen');
    expect(noteOf('Zen')).toBe('No profile with cookies was found.');
    expect(zen.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(zen);
    expect(zen.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(useButton());
    // Never an empty spec for Rust to save.
    expect(onUse).not.toHaveBeenCalled();
    expect(useButton().getAttribute('aria-disabled')).toBe('true');
  });

  test('a browser that can be chosen is not marked disabled', async () => {
    await open();

    for (const name of ['Firefox', 'LibreWolf', 'Microsoft Edge', 'Google Chrome']) {
      expect(radio(name).hasAttribute('aria-disabled'), name).toBe(false);
    }
  });
});

describe('choosing', () => {
  test('nothing is chosen at first, and Use and try again waits for a choice', async () => {
    const { onUse } = await open();

    expect(screen.getAllByRole('radio').map((row) => row.getAttribute('aria-checked'))).toEqual(
      FOUND.map(() => 'false'),
    );
    expect(useButton().getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(useButton());
    expect(onUse).not.toHaveBeenCalled();
  });

  test('the choice is marked, and Use and try again gives its spec', async () => {
    const { onUse } = await open();

    fireEvent.click(radio('LibreWolf'));

    expect(radio('LibreWolf').getAttribute('aria-checked')).toBe('true');
    expect(radio('Firefox').getAttribute('aria-checked')).toBe('false');
    expect(useButton().getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(useButton());
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onUse).toHaveBeenCalledWith('firefox:abc123.default-release');
  });

  test('a second choice replaces the first', async () => {
    const { onUse } = await open();

    fireEvent.click(radio('Firefox'));
    fireEvent.click(radio('Microsoft Edge'));
    fireEvent.click(useButton());

    expect(radio('Firefox').getAttribute('aria-checked')).toBe('false');
    expect(onUse).toHaveBeenCalledWith('edge');
  });

  test('while the choice is saved, the list and the button do nothing', async () => {
    const { onUse, props, rerender } = await open();
    fireEvent.click(radio('Firefox'));

    rerender(<BrowserChooser {...props} busy />);
    fireEvent.click(radio('Microsoft Edge'));
    fireEvent.click(useButton());

    expect(radio('Firefox').getAttribute('aria-checked')).toBe('true');
    expect(radio('Microsoft Edge').getAttribute('aria-checked')).toBe('false');
    expect(useButton().getAttribute('aria-disabled')).toBe('true');
    expect(onUse).not.toHaveBeenCalled();
  });
});

describe('no cookies', () => {
  test('is offered last where the cookies of the browser chosen before cannot be read, and gives null', async () => {
    const { onUse } = await open({ offerNone: true });

    expect(names().at(-1)).toBe(NO_COOKIES);
    expect(radio(NO_COOKIES).hasAttribute('aria-disabled')).toBe(false);

    fireEvent.click(radio(NO_COOKIES));
    fireEvent.click(useButton());

    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onUse).toHaveBeenCalledWith(null);
  });

  test('is not offered otherwise', async () => {
    await open();

    expect(screen.queryByRole('radio', { name: NO_COOKIES })).toBeNull();
  });
});

describe('the keyboard', () => {
  test('the arrows, Home and End move the focus through the list and say so, so mpv does not get them', async () => {
    await open();
    const rows = ['Firefox', 'LibreWolf', 'Microsoft Edge', 'Google Chrome', 'Zen'].map(radio);
    act(() => {
      radio('Firefox').focus();
    });

    const press = (key: string) => {
      const handled = !fireEvent.keyDown(document.activeElement as HTMLElement, { key });
      return handled;
    };

    expect(press('ArrowDown')).toBe(true);
    expect(document.activeElement).toBe(rows[1]);
    expect(press('ArrowRight')).toBe(true);
    expect(document.activeElement).toBe(rows[2]);
    expect(press('ArrowUp')).toBe(true);
    expect(document.activeElement).toBe(rows[1]);
    expect(press('ArrowLeft')).toBe(true);
    expect(document.activeElement).toBe(rows[0]);
    // The ends hold.
    expect(press('ArrowUp')).toBe(true);
    expect(document.activeElement).toBe(rows[0]);
    expect(press('End')).toBe(true);
    // The one without a profile can be reached, to read why it cannot be chosen.
    expect(document.activeElement).toBe(rows[4]);
    expect(press('ArrowDown')).toBe(true);
    expect(document.activeElement).toBe(rows[4]);
    expect(press('Home')).toBe(true);
    expect(document.activeElement).toBe(rows[0]);
  });

  test('the focus on the way chooses nothing', async () => {
    await open();
    act(() => {
      radio('Firefox').focus();
    });

    fireEvent.keyDown(radio('Firefox'), { key: 'ArrowDown' });

    expect(screen.getAllByRole('radio').some((row) => row.getAttribute('aria-checked') === 'true')).toBe(
      false,
    );
  });

  test('other keys are left alone, and so are the arrows with Ctrl', async () => {
    await open();
    act(() => {
      radio('Firefox').focus();
    });

    expect(fireEvent.keyDown(radio('Firefox'), { key: 'a' })).toBe(true);
    expect(fireEvent.keyDown(radio('Firefox'), { key: 'ArrowDown', ctrlKey: true })).toBe(true);
    expect(document.activeElement).toBe(radio('Firefox'));
  });

  test('Tab reaches one row: the choice, else the first browser that can be chosen', async () => {
    await open();
    const stops = () =>
      screen.getAllByRole('radio').filter((row) => row.getAttribute('tabindex') === '0');

    expect(stops()).toEqual([radio('Firefox')]);

    fireEvent.click(radio('Google Chrome'));
    expect(stops()).toEqual([radio('Google Chrome')]);
  });

  test('opened with the keyboard, the focus goes to the list once it is there', async () => {
    await open({ focusOnReady: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(radio('Firefox'));
    });
  });

  test('opened with the pointer, the focus is left alone', async () => {
    await open({ focusOnReady: false });

    expect(document.activeElement).toBe(document.body);
  });
});

describe('no browser to choose', () => {
  test('none found: a sentence and a link to Settings → Playback, and nothing to use', async () => {
    await open({}, []);

    expect(screen.getByText('No browser was found whose cookies can be used.')).toBeTruthy();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use and try again' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Settings → Playback' }));

    expect(useUiStore.getState().page).toBe('settings');
  });

  test('none found: the focus goes to the link when it was opened with the keyboard', async () => {
    await open({ focusOnReady: true }, []);

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Settings → Playback' }));
    });
  });

  test('none found, but no cookies is on offer: that is still a choice, next to the link', async () => {
    const { onUse } = await open({ offerNone: true }, []);

    expect(names()).toEqual([NO_COOKIES]);
    expect(screen.getByText('No browser was found whose cookies can be used.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Settings → Playback' })).toBeTruthy();

    fireEvent.click(radio(NO_COOKIES));
    fireEvent.click(useButton());
    expect(onUse).toHaveBeenCalledWith(null);
  });

  test('only browsers without a profile: they are shown, and the way on is Settings', async () => {
    await open({}, [ZEN, browser('floorp', 'Floorp', '', 'noProfile')]);

    expect(names()).toEqual(['Zen', 'Floorp']);
    expect(screen.getByRole('button', { name: 'Settings → Playback' })).toBeTruthy();
    expect(useButton().getAttribute('aria-disabled')).toBe('true');
  });

  test('a list that cannot be read says so, with the same way out', async () => {
    vi.mocked(invoke).mockImplementation((() => Promise.reject(new Error('no disk'))) as unknown as typeof invoke);

    render(<BrowserChooser offerNone={false} busy={false} focusOnReady={false} onUse={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('The browsers could not be listed.');
    });
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByRole('button', { name: 'Settings → Playback' })).toBeTruthy();
    expect(console.warn).toHaveBeenCalledWith('system_browsers', expect.any(Error));
  });
});

describe('language', () => {
  test('the chooser is in the language of the app, also when it changes', async () => {
    await open({ offerNone: true });

    act(() => {
      setLanguage('cs');
    });

    expect(screen.getByRole('radiogroup', { name: 'Brát cookies z' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Nepoužívat cookies' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Použít a zkusit znovu' })).toBeTruthy();
    expect(noteOf('Zen')).toBe('Profil s cookies se nenašel.');
  });
});
