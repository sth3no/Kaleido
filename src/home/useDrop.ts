/**
 * Dropping on the window (plan decision 8, spec 8.5): the whole window takes a drop, whichever page
 * is shown, and the app never navigates to what was dropped.
 *
 * - `dragover` is always cancelled. WebView2 turns an uncancelled drop of a file into a
 *   navigation to it, which would replace the app; the drop then does not happen at all.
 * - Files are handed to WebView2 (`postMessageWithAdditionalObjects`), and Rust reads their
 *   paths (src-tauri/src/system/drop.rs): the UI never sees a path.
 * - A link (`text/uri-list`, or text that is one http(s) link) plays at once, like Ctrl+V.
 * - While something is dragged over the window the hook says so, for the start screen to show
 *   its drop zone.
 *
 * Call it once, from the root of the app: two calls would handle every drop twice.
 */

import { useEffect, useState } from 'react';

import { playerLoad } from '../ipc/commands';
import { useUiStore } from '../state/uiStore';

/**
 * The message posted with dropped files. A JSON object, not a string: Tauri's IPC also hears every
 * string message and logs an error for one it cannot parse, while it never sees an object. The
 * Rust side checks the `type` (src-tauri/src/system/drop.rs reads the same
 * src-tauri/tests/fixtures/drop/message.json as this file's test).
 */
export const DROP_MESSAGE = { type: 'kaleido:drop' } as const;

/** What a drag can carry that Kaleido opens: files, and a link as `text/uri-list` or as text. */
const OPENABLE_TYPES = ['Files', 'text/uri-list', 'text/plain'];

/** Whether the drag carries something Kaleido can open (the contents are readable on drop only). */
function carriesOpenable(e: DragEvent): boolean {
  const types = Array.from(e.dataTransfer?.types ?? []);
  return OPENABLE_TYPES.some((type) => types.includes(type));
}

/** `text` if it is one http(s) link, else `null`. */
function asWebLink(text: string): string | null {
  const link = text.trim();
  // One address: no spaces, no second line.
  if (link === '' || /\s/.test(link)) return null;
  try {
    const { protocol } = new URL(link);
    return protocol === 'http:' || protocol === 'https:' ? link : null;
  } catch {
    return null;
  }
}

/**
 * The link a drop carries: the first http(s) address of its `text/uri-list` (one address per line,
 * lines starting with `#` are comments), else its text if that is one link. `null` for anything
 * else (a file path, `javascript:`, plain words).
 */
export function linkFromDrop(data: Pick<DataTransfer, 'getData'>): string | null {
  for (const line of data.getData('text/uri-list').split(/\r?\n/)) {
    const link = asWebLink(line);
    if (link) return link;
  }
  return asWebLink(data.getData('text/plain'));
}

/** Hands the dropped files to WebView2, which gives them to Rust. */
function handOverFiles(files: ArrayLike<File>): void {
  const webview = window.chrome?.webview;
  if (!webview) {
    console.warn('dropped files cannot be opened: this window is not WebView2');
    return;
  }
  try {
    webview.postMessageWithAdditionalObjects(DROP_MESSAGE, Array.from(files));
  } catch (error: unknown) {
    console.warn('cannot hand the dropped files to Rust', error);
  }
}

/** Plays the dropped link in place of what is open; the player is the page to show for it. */
function openLink(link: string): void {
  playerLoad([link], 'replace').then(
    () => {
      useUiStore.getState().setPage('player');
    },
    (issues: unknown) => {
      console.warn('cannot open the dropped link', link, issues);
    },
  );
}

/** Takes drops on the whole window. Returns whether something is being dragged over it. */
export function useDrop(): boolean {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    const { signal } = abort;
    // dragenter and dragleave fire for every element the pointer crosses, a child's dragenter
    // before its parent's dragleave: the drag is over the window while the count is above zero.
    let depth = 0;

    window.addEventListener(
      'dragenter',
      (e) => {
        e.preventDefault();
        depth += 1;
        if (carriesOpenable(e)) setDragging(true);
      },
      { signal },
    );
    window.addEventListener(
      'dragover',
      (e) => {
        // Always: an uncancelled drop navigates to the file. What cannot be opened shows the
        // "not allowed" pointer instead.
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = carriesOpenable(e) ? 'copy' : 'none';
      },
      { signal },
    );
    window.addEventListener(
      'dragleave',
      () => {
        depth = Math.max(0, depth - 1);
        if (depth === 0) setDragging(false);
      },
      { signal },
    );
    window.addEventListener(
      'drop',
      (e) => {
        e.preventDefault();
        depth = 0;
        setDragging(false);
        const data = e.dataTransfer;
        if (!data) return;
        // Files first: a browser may add a link to the file it drags.
        if (data.files.length > 0) {
          handOverFiles(data.files);
          return;
        }
        const link = linkFromDrop(data);
        if (link) openLink(link);
      },
      { signal },
    );

    return () => {
      abort.abort();
    };
  }, []);

  return dragging;
}
