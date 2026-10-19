/**
 * What the buttons of a link's card do (spec 10.3): "Try again" and "Update and try again" open the
 * link once more, "Use and try again" saves the browser to take cookies from and then does the same.
 * Both are Rust's own commands: `stream_retry` hands the link to the player the way a pasted link goes
 * (and with `update` it updates yt-dlp first, which downloads, so it may take a while), and
 * `settings_set` takes a patch holding that one setting, never the whole of the settings.
 *
 * The card is busy while an action runs (`RetryPhase`), and each function resolves with whether the
 * link is now with the player. The card closes itself then (`ErrorCard.tsx`, which also puts the
 * focus back); when Rust refused, the card stays and says so, and the action is offered again.
 */

import { settingsSet, streamRetry } from '../../ipc/commands';
import { useSettingsStore } from '../../settings/store';
import { useNoticeStore } from '../../state/noticeStore';
import { useUiStore } from '../../state/uiStore';

/** Whether the card `id` is there and is no busy one: the actions do nothing twice. */
function canStart(id: number): boolean {
  const card = useNoticeStore.getState().notices.find((notice) => notice.id === id);
  return card?.kind === 'playback' && card.retry !== 'working';
}

/** Opens `url` again; `true` once Rust has taken it, `false` (and the card says so) if it refused. */
async function openAgain(id: number, url: string, update: boolean): Promise<boolean> {
  try {
    await streamRetry(url, update);
  } catch (error) {
    console.warn('cannot try the link again', error);
    useNoticeStore.getState().setRetryPhase(id, 'refused');
    return false;
  }
  return true;
}

/**
 * "Try again" (`update: false`) and "Update and try again" (`update: true`) on the card `id`. The
 * promise resolves when Rust has answered; with `update` that is after yt-dlp was updated (an update
 * that fails does not stop the retry, Rust logs it and the link fails as before, with a card of its
 * own). Resolves `false` at once for a card that is busy or gone.
 */
export async function retryFromNotice(id: number, url: string, update: boolean): Promise<boolean> {
  if (!canStart(id)) return false;
  useNoticeStore.getState().setRetryPhase(id, 'working');
  const taken = await openAgain(id, url, update);
  // The card whose link was taken is the caller's to close; one that was refused says so (set above).
  if (taken) useNoticeStore.getState().setRetryPhase(id, 'idle');
  return taken;
}

/**
 * "Use and try again" on the card `id`: saves `spec` (one `Browser.spec`, `null` for no cookies) as
 * `playback.cookiesFromBrowser`, then opens `url` again without an update. A choice that cannot be
 * saved stops there (`unsaved`): the link is not tried with cookies that are not the user's choice.
 */
export async function saveCookiesAndRetry(
  id: number,
  url: string,
  spec: string | null,
): Promise<boolean> {
  if (!canStart(id)) return false;
  useNoticeStore.getState().setRetryPhase(id, 'working');
  try {
    // The patch holds this one setting; the answer is the settings as they are now.
    useSettingsStore.getState().setKaleido(await settingsSet({ playback: { cookiesFromBrowser: spec } }));
  } catch (error) {
    console.warn('cannot save the browser for cookies', error);
    useNoticeStore.getState().setRetryPhase(id, 'unsaved');
    return false;
  }
  const taken = await openAgain(id, url, false);
  if (taken) useNoticeStore.getState().setRetryPhase(id, 'idle');
  return taken;
}

/** The link of the chooser that found no browser: to Settings, which opens on Playback. */
export function openPlaybackSettings(): void {
  useUiStore.getState().setPage('settings');
}
