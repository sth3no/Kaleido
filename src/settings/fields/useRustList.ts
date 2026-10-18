/**
 * A list the field asks Rust for when it shows (the fonts, the audio devices, the shader files).
 * `items` is `null` while it is on its way, then the list. A list Rust cannot give (the command
 * fails, or answers with something that is no list) is `failed`, not an empty list: the field says so
 * and offers `retry`, and the reason goes to the console. The field still shows the value it has.
 */

import { useCallback, useEffect, useState } from 'react';

export interface RustList<T> {
  items: T[] | null;
  failed: boolean;
  /** Asks again. */
  retry: () => void;
}

interface State<T> {
  items: T[] | null;
  failed: boolean;
}

export function useRustList<T>(load: () => Promise<T[]>, what: string): RustList<T> {
  const [state, setState] = useState<State<T>>({ items: null, failed: false });
  /** Counts the asks: a new one runs the effect again. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    load().then(
      (answer) => {
        if (!current) return;
        if (Array.isArray(answer)) {
          setState({ items: answer, failed: false });
        } else {
          console.warn(`${what} did not answer with a list`, answer);
          setState({ items: null, failed: true });
        }
      },
      (error: unknown) => {
        console.warn(`cannot read ${what}`, error);
        if (current) setState({ items: null, failed: true });
      },
    );
    return () => {
      current = false;
    };
  }, [load, what, attempt]);

  const retry = useCallback(() => {
    setState({ items: null, failed: false });
    setAttempt((count) => count + 1);
  }, []);

  return { items: state.items, failed: state.failed, retry };
}
