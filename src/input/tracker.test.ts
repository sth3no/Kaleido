import { describe, expect, it } from 'vitest';
import { createKeyTracker } from './tracker';

describe('createKeyTracker', () => {
  it('releases with the name used on press even if Ctrl went up first', () => {
    const t = createKeyTracker();
    expect(t.down('KeyA', 'Ctrl+a')).toBe(true);
    expect(t.up('KeyA')).toBe('Ctrl+a');
    expect(t.up('KeyA')).toBeNull();
  });

  it('ignores a second press of a held key', () => {
    const t = createKeyTracker();
    t.down('ArrowRight', 'RIGHT');
    expect(t.down('ArrowRight', 'RIGHT')).toBe(false);
  });

  it('releases everything on focus loss', () => {
    const t = createKeyTracker();
    t.down('ArrowRight', 'RIGHT');
    t.down('KeyZ', 'z');
    expect(t.releaseAll().sort()).toEqual(['RIGHT', 'z']);
    expect(t.releaseAll()).toEqual([]);
  });
});
