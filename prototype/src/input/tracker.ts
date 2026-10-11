/** Remembers the mpv name sent for each physical key so keyup always matches keydown. */
export function createKeyTracker() {
  const held = new Map<string, string>();
  return {
    down(code: string, key: string): boolean {
      if (held.has(code)) return false;
      held.set(code, key);
      return true;
    },
    up(code: string): string | null {
      const key = held.get(code) ?? null;
      held.delete(code);
      return key;
    },
    releaseAll(): string[] {
      const keys = [...held.values()];
      held.clear();
      return keys;
    },
  };
}
