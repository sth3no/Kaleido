export type FullscreenDeps = {
  setCurtain(on: boolean): void;
  nextFrame(): Promise<void>;
  setWindowFullscreen(on: boolean): Promise<void>;
  waitForResize(timeoutMs: number): Promise<void>;
};

/** Keeps a black curtain over the window while it switches mode, until mpv has resized (spec 5.1). */
export function createFullscreenController(deps: FullscreenDeps): (on: boolean) => Promise<void> {
  let current = false;
  let queue = Promise.resolve();
  return (on) => {
    queue = queue.then(async () => {
      if (on === current) return;
      current = on;
      deps.setCurtain(true);
      await deps.nextFrame();
      await deps.nextFrame();
      await deps.setWindowFullscreen(on);
      await deps.waitForResize(400);
      await deps.nextFrame();
      deps.setCurtain(false);
    });
    return queue;
  };
}

export const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
