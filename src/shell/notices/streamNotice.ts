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
import type { SourceError } from '../../ipc/types';
import { useSettingsStore } from '../../settings/store';
import { useNoticeStore, type PlaybackNotice } from '../../state/noticeStore';
import { useUiStore } from '../../state/uiStore';

/**
 * The keys of the sentences a link's card says when its action did not go through, in the order
 * they are read; none while it did not fail. A link Rust refused is told in the words of the paste
 * field (`home.paste.errors.*`), and a choice of the browser that was saved before says so.
 */
export function problemKeys(notice: PlaybackNotice): string[] {
  if (notice.retry === 'unsaved') return ['errors.streamAction.unsaved'];
  if (notice.retry !== 'refused') return [];
  const kind = notice.refusal?.kind ?? null;
  const why =
    kind === 'invalid'
      ? 'home.paste.errors.invalid'
      : kind === 'protocol'
        ? 'home.paste.errors.protocol'
        : 'errors.streamAction.refused';
  return notice.refusal?.saved === true ? [why, 'errors.streamAction.saved'] : [why];
}

/** Whether the card `id` is there and is no busy one: the actions do nothing twice. */
function canStart(id: number): boolean {
  const card = useNoticeStore.getState().notices.find((notice) => notice.id === id);
  return card?.kind === 'playback' && card.retry !== 'working';
}

/** What Rust said about the link when it refused it (a `LoadIssue`); `null` for any other failure. */
function refusalKind(error: unknown): SourceError | null {
  if (typeof error !== 'object' || error === null || !('kind' in error)) return null;
  const { kind } = error;
  return kind === 'invalid' || kind === 'protocol' || kind === 'notFound' ? kind : null;
}

/**
 * Opens `url` again; `true` once Rust has taken it, `false` (and the card says why) if it refused.
 * `saved`: the choice of the browser went in before, which the card then says.
 */
async function openAgain(id: number, url: string, update: boolean, saved: boolean): Promise<boolean> {
  try {
    await streamRetry(url, update);
  } catch (error) {
    console.warn('cannot try the link again', error);
    useNoticeStore.getState().setRetryPhase(id, 'refused', { kind: refusalKind(error), saved });
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
  const taken = await openAgain(id, url, update, false);
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
  const taken = await openAgain(id, url, false, true);
  if (taken) useNoticeStore.getState().setRetryPhase(id, 'idle');
  return taken;
}

/**
 * The link of the chooser that found no browser: to Settings, which opens on Playback. The card has
 * done its job by then and closes first (`ErrorCard.tsx`), so that it does not stay over the page.
 */
export function openPlaybackSettings(): void {
  useUiStore.getState().setPage('settings');
}
