import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MAX_REGIONS, measure, sameRects, type GlassRect } from './regions';

/** Keeps mpv's blur regions on top of every [data-glass] element, also during transitions. */
export function useGlassRegions(enabled: boolean) {
  useEffect(() => {
    let last: GlassRect[] = [];
    let frame = 0;
    let running = 0;

    const push = (rects: GlassRect[]) => {
      if (sameRects(rects, last)) return;
      last = rects;
      invoke('glass_set_regions', { rects }).catch((e) => console.warn('glass_set_regions', e));
    };
    const collect = (): GlassRect[] =>
      enabled
        ? [...document.querySelectorAll<HTMLElement>('[data-glass]')]
            .map((el) => measure(el, getComputedStyle(el)))
            .filter((r): r is GlassRect => r !== null)
            .slice(0, MAX_REGIONS)
        : [];
    const loop = () => {
      push(collect());
      frame = running > 0 ? requestAnimationFrame(loop) : 0;
    };
    const kick = () => {
      if (!frame) frame = requestAnimationFrame(loop);
    };
    const onStart = () => {
      running += 1;
      kick();
    };
    const onEnd = () => {
      running = Math.max(0, running - 1);
      kick();
    };

    const resize = new ResizeObserver(kick);
    resize.observe(document.body);
    const mutations = new MutationObserver(kick);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    document.addEventListener('transitionrun', onStart);
    document.addEventListener('transitionend', onEnd);
    document.addEventListener('transitioncancel', onEnd);
    kick();

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      document.removeEventListener('transitionrun', onStart);
      document.removeEventListener('transitionend', onEnd);
      document.removeEventListener('transitioncancel', onEnd);
      invoke('glass_set_regions', { rects: [] }).catch(() => undefined);
    };
  }, [enabled]);
}
