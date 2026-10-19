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
 *
 * "Update and try again" opens the link only when the update put something new in place (final
 * review I-1): pressed again and again on a yt-dlp that is already the newest, it would bring the
 * same card back for ever. When there was nothing new the card stays and says what the update found
 * (`findingOf`, `findingText`): Deno missing for a YouTube link, a check that failed, or a yt-dlp
 * that is the newest already, with Settings → Updates beside the action: the update again where it
 * may help, otherwise "Try again" (`retryFromNotice` without `update`, final fix wave R19).
 */

import type { TFunction } from 'i18next';

import { settingsSet, streamRetry } from '../../ipc/commands';
import type { LinkUpdate, SourceError, StreamError } from '../../ipc/types';
import { useSettingsStore } from '../../settings/store';
import { useNoticeStore, type PlaybackNotice, type UpdateFinding } from '../../state/noticeStore';
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
 * What the update for the link of a card whose class is `stream` found, when it put nothing new in
 * place (`found.updated` is false), in the order that explains the failure best: a check of yt-dlp
 * that failed (offline, Deno could not come either), then a Deno the link needs and does not have,
 * then a yt-dlp that is there but could not be started (the link said it is missing), and
 * otherwise a yt-dlp that is the newest.
 */
export function findingOf(found: LinkUpdate, stream: StreamError | null): UpdateFinding {
  if (found.ytDlp.state !== 'ready') return { kind: 'failed', status: found.ytDlp };
  if (found.deno !== null && found.deno.state !== 'ready') return { kind: 'deno', status: found.deno };
  if (stream === 'missing') return { kind: 'blocked' };
  return { kind: 'newest', version: found.ytDlp.version, nightly: found.channel === 'nightly' };
}

/** Rust's reason in a status, where it gave one (in English). */
const reasonOf = (error: string | null): string | null =>
  error !== null && error.trim() !== '' ? error : null;

/**
 * What a card says about `finding`: the sentence, and Rust's reason after it where there is one
 * (`detail`, English whatever the language of the UI).
 */
export function findingText(
  finding: UpdateFinding,
  t: TFunction,
): { text: string; detail: string | null } {
  switch (finding.kind) {
    case 'deno': {
      const missing = finding.status.state === 'missing';
      return {
        text: t(missing ? 'errors.streamUpdate.denoMissing' : 'errors.streamUpdate.denoFailed'),
        detail: reasonOf(finding.status.error),
      };
    }
    case 'failed':
      return { text: t('errors.streamUpdate.failed'), detail: reasonOf(finding.status.error) };
    case 'blocked':
      return { text: t('errors.streamUpdate.blocked'), detail: null };
    case 'newest': {
      const newest =
        finding.version === null
          ? t('errors.streamUpdate.newestUnknown')
          : t('errors.streamUpdate.newest', { version: finding.version });
      // The hint at the nightly builds is no help to one that has them.
      const text = finding.nightly ? newest : `${newest} ${t('errors.streamUpdate.nightly')}`;
      return { text, detail: null };
    }
  }
}

/**
 * Whether the card still offers the update after `finding`: again for Deno and a check that
 * failed (the network may be back; the update checks Deno too), not when it would change nothing
 * (the newest already, a yt-dlp that could not be started). "Try again", a plain retry, takes its
 * place then (`ErrorCard.tsx`): the link may still play on a second try.
 */
export const offersUpdateAfter = (finding: UpdateFinding | null): boolean =>
  finding === null || finding.kind === 'deno' || finding.kind === 'failed';

/**
 * Opens `url` again; `true` once Rust has taken it, `false` (and the card says why) if it refused,
 * or if the update found nothing new to try it with (Rust did not open it then). `saved`: the
 * choice of the browser went in before, which the card then says.
 */
async function openAgain(id: number, url: string, update: boolean, saved: boolean): Promise<boolean> {
  let found: LinkUpdate | null;
  try {
    found = await streamRetry(url, update);
  } catch (error) {
    console.warn('cannot try the link again', error);
    useNoticeStore.getState().setRetryPhase(id, 'refused', { kind: refusalKind(error), saved });
    return false;
  }
  if (found !== null && !found.updated) {
    const card = useNoticeStore.getState().notices.find((notice) => notice.id === id);
    const stream = card?.kind === 'playback' ? card.stream : null;
    useNoticeStore.getState().setUnchanged(id, findingOf(found, stream));
    return false;
  }
  return true;
}

/**
 * "Try again" (`update: false`) and "Update and try again" (`update: true`) on the card `id`. The
 * promise resolves when Rust has answered; with `update` that is after the update (Rust opens the
 * link only when it put something new in place; otherwise the card says what it found and stays).
 * Resolves `false` at once for a card that is busy or gone.
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
 * The link of the chooser that found no browser: to Settings → Playback. The card has done its job
 * by then and closes first (`ErrorCard.tsx`), so that it does not stay over the page.
 */
export function openPlaybackSettings(): void {
  useUiStore.getState().openSettings('playback');
}

/**
 * The link of a card whose update found nothing new: to Settings → Updates (the channel, the
 * tools and their reasons). The card closes first, as for the chooser's link.
 */
export function openUpdatesSettings(): void {
  useUiStore.getState().openSettings('updates');
}
