/**
 * A list the field asks Rust for when it shows (the fonts, the audio devices, the shader files):
 * `null` while it is on its way, then the list. A list Rust cannot give is an empty one, and the
 * reason goes to the console; the field still shows the value it has.
 */

import { useEffect, useState } from 'react';

export function useRustList<T>(load: () => Promise<T[]>, what: string): T[] | null {
  const [list, setList] = useState<T[] | null>(null);

  useEffect(() => {
    let current = true;
    load().then(
      (answer) => {
        if (current) setList(Array.isArray(answer) ? answer : []);
      },
      (error: unknown) => {
        console.warn(`cannot read ${what}`, error);
        if (current) setList([]);
      },
    );
    return () => {
      current = false;
    };
  }, [load, what]);

  return list;
}
