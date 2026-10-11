import { describe, expect, it } from 'vitest';
import { createFullscreenController, type FullscreenDeps } from './fullscreen';

function fake(): { log: string[]; deps: FullscreenDeps } {
  const log: string[] = [];
  return {
    log,
    deps: {
      setCurtain: (on) => { log.push(on ? 'curtain:on' : 'curtain:off'); },
      nextFrame: async () => { log.push('frame'); },
      setWindowFullscreen: async (on) => { log.push(`fs:${on}`); },
      waitForResize: async () => { log.push('resize'); },
    },
  };
}

describe('createFullscreenController', () => {
  it('covers the switch with the curtain until mpv has the new size', async () => {
    const { log, deps } = fake();
    await createFullscreenController(deps)(true);
    expect(log).toEqual(['curtain:on', 'frame', 'frame', 'fs:true', 'resize', 'frame', 'curtain:off']);
  });

  it('does nothing when already in the requested mode', async () => {
    const { log, deps } = fake();
    await createFullscreenController(deps)(false);
    expect(log).toEqual([]);
  });

  it('serializes rapid toggles', async () => {
    const { log, deps } = fake();
    const apply = createFullscreenController(deps);
    await Promise.all([apply(true), apply(false)]);
    expect(log.filter((l) => l.startsWith('fs:'))).toEqual(['fs:true', 'fs:false']);
  });
});
