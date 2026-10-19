/**
 * The state of the managed tools (yt-dlp and Deno) for the settings page: Updates lists them, About
 * shows their versions. `tools_status` is read when the page that uses it shows, and `tools:status`
 * keeps it live (a check began, a download began, how it ended).
 *
 * A read can be overtaken: an event that came after the read began is newer than the read's answer,
 * so the answer does not replace what the event said (the way `store.ts` keeps the settings).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { toolsStatus } from '../ipc/commands';
import { onToolsStatus } from '../ipc/events';
import { listenTo } from '../ipc/listen';
import type { ToolId, ToolStatus } from '../ipc/types';

export type ToolStatuses = Readonly<Partial<Record<ToolId, ToolStatus>>>;

/** Whether `value` is a tool's state as Rust gives it (a mock that answers with nothing is not). */
export function isToolStatus(value: unknown): value is ToolStatus {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tool' in value &&
    (value.tool === 'ytDlp' || value.tool === 'deno') &&
    'state' in value &&
    typeof value.state === 'string'
  );
}

export interface ToolStatusesState {
  /** What is known of each tool; `null` until the first answer or event. */
  statuses: ToolStatuses | null;
  /** The last read failed (a tool an event told about has its state all the same). */
  failed: boolean;
  /** Reads again. */
  retry: () => void;
  /** Takes a state Rust gave (the answer of a check) as the newest. */
  apply: (status: ToolStatus) => void;
}

export function useToolStatuses(): ToolStatusesState {
  const [statuses, setStatuses] = useState<ToolStatuses | null>(null);
  const [failed, setFailed] = useState(false);
  /** Counts the reads: a new one runs the effect again. */
  const [attempt, setAttempt] = useState(0);
  /** The tools that were told about since the read began: the read is older than that. */
  const heard = useRef(new Set<ToolId>());

  const apply = useCallback((status: ToolStatus) => {
    heard.current.add(status.tool);
    setStatuses((now) => ({ ...now, [status.tool]: status }));
  }, []);

  // Subscribed before the read: a change in between is not lost.
  useEffect(
    () =>
      listenTo(
        onToolsStatus,
        (status) => {
          if (isToolStatus(status)) apply(status);
        },
        'tools:status',
      ),
    [apply],
  );

  useEffect(() => {
    let current = true;
    heard.current.clear();
    toolsStatus().then(
      (list) => {
        if (!current) return;
        if (!Array.isArray(list)) {
          console.warn('tools_status did not answer with a list', list);
          setFailed(true);
          return;
        }
        setFailed(false);
        setStatuses((now) => {
          const next: Partial<Record<ToolId, ToolStatus>> = { ...now };
          for (const status of list) {
            if (isToolStatus(status) && !heard.current.has(status.tool)) next[status.tool] = status;
          }
          return next;
        });
      },
      (error: unknown) => {
        console.warn('cannot read the state of the tools', error);
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setFailed(false);
    setAttempt((count) => count + 1);
  }, []);

  return { statuses, failed, retry, apply };
}
