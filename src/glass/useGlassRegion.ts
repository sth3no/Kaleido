/**
 * The glass regions over the video (spec 8.2). Every element with glass over the video registers
 * itself with `useGlassRegion`; the shared list of their rectangles (at most `MAX_REGIONS`, in the
 * order they registered, the invisible ones left out) goes to Rust with `glassSetRegions`, at most
 * once per animation frame and only when it changed. While the glass is off (`uiStore.glass`: the
 * user's "reduce transparency", Windows, or a failed shader) the list is empty, and the panels are
 * opaque (`data-reduce-transparency`, theme/glass.module.css).
 *
 * The rectangles are measured again whenever something may have moved them: the window resizes or
 * scrolls, a registered element changes size (ResizeObserver), the root changes (the UI scale and
 * the tokens are attributes of it), and on every frame while a transition runs on a registered
 * element or one of its ancestors (an island that slides in or fades out). Nothing runs while
 * nothing changes, so a paused or playing video with still controls costs nothing here (spec 13).
 *
 * `createRectSet` is the same machinery for any list of measured rectangles: the window buttons
 * Windows hit-tests itself use it too (shell/captionButtons.ts).
 */

import { useEffect, type RefObject } from 'react';

import { glassSetRegions } from '../ipc/commands';
import { useUiStore } from '../state/uiStore';
import { readZoomFrame } from '../theme/zoom';
import { MAX_REGIONS, measure, opacityOf, sameRects, type GlassRect } from './regions';

/** A transition that never ends (its element went away half-way) is given up on after this. */
const STUCK_TRANSITION_MS = 1000;

/** An element whose rectangle is in the list. */
export interface RectSource {
  element: HTMLElement;
  /** The corner radius in the element's own CSS px; left out, its own border radius. */
  radius?: number;
}

export interface RectSetOptions {
  /** Sends the list; called at most once per frame, and only with a list that changed. */
  send: (rects: GlassRect[]) => Promise<unknown>;
  /** For the warning when sending fails. */
  what: string;
  /** At most this many rectangles go; the first registered are kept. */
  cap?: number;
  /** Whether anything is sent; while not, the list is empty. Asked at every measurement. */
  enabled?: () => boolean;
  /** Calls `changed` whenever `enabled` may have changed; returns the function that stops it. */
  watch?: (changed: () => void) => () => void;
  /** What of a rectangle counts (and is compared): all of it by default. */
  shape?: (rect: GlassRect) => GlassRect;
}

export interface RectSet {
  /** Puts an element in the list; returns the function that takes it out again. */
  add: (source: RectSource) => () => void;
  /** Measures again at the next animation frame (once, however often it is asked). */
  schedule: () => void;
}

/** The opacity an element is shown with: its own times its ancestors' (a fading island fades its glass). */
function shownOpacity(element: Element, own: CSSStyleDeclaration): number {
  let opacity = opacityOf(own.opacity);
  for (let node = element.parentElement; node && opacity > 0.01; node = node.parentElement) {
    opacity *= opacityOf(getComputedStyle(node).opacity);
  }
  return opacity;
}

/** A list of measured rectangles that keeps Rust up to date (see the top of the file). */
export function createRectSet(options: RectSetOptions): RectSet {
  const {
    send,
    what,
    cap = Number.POSITIVE_INFINITY,
    enabled = () => true,
    watch,
    shape = (rect: GlassRect) => rect,
  } = options;
  const sources: RectSource[] = [];
  // ResizeObserver exists in every engine Kaleido runs in; not in the tests' jsdom.
  const resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;
  /** The transitions running on each element that concerns the list (one per property). */
  const transitions = new Map<EventTarget, number>();
  /** When a transition last started or ended. */
  let lastTransition = 0;
  let frame: number | null = null;
  /** What Rust has; `null` before the first send. */
  let last: GlassRect[] | null = null;
  let stopListening: (() => void) | null = null;

  const collect = (): GlassRect[] => {
    if (!enabled()) return [];
    const zoom = readZoomFrame();
    const rects: GlassRect[] = [];
    for (const { element, radius } of sources) {
      if (rects.length >= cap) break;
      if (!element.isConnected) continue;
      const style = getComputedStyle(element);
      const rect = measure(element, style, { frame: zoom, radius, opacity: shownOpacity(element, style) });
      if (rect) rects.push(shape(rect));
    }
    return rects;
  };

  const animating = (): boolean => {
    if (transitions.size === 0) return false;
    if (performance.now() - lastTransition > STUCK_TRANSITION_MS) {
      transitions.clear();
      return false;
    }
    return true;
  };

  const flush = () => {
    frame = null;
    const rects = collect();
    if (last === null || !sameRects(rects, last)) {
      last = rects;
      send(rects).catch((error: unknown) => {
        console.warn(what, error);
      });
    }
    if (sources.length === 0) {
      stopListening?.();
      stopListening = null;
    } else if (animating()) {
      schedule();
    }
  };

  function schedule(): void {
    frame ??= requestAnimationFrame(flush);
  }

  /** A transition on a registered element or on an ancestor of one may move or fade it. */
  const concerns = (target: EventTarget | null): target is Node =>
    target instanceof Node && sources.some(({ element }) => target.contains(element));

  const onTransitionRun = (e: Event) => {
    if (!concerns(e.target)) return;
    transitions.set(e.target, (transitions.get(e.target) ?? 0) + 1);
    lastTransition = performance.now();
    schedule();
  };

  const onTransitionStop = (e: Event) => {
    const target = e.target;
    if (target === null || !transitions.has(target)) return;
    const running = (transitions.get(target) ?? 1) - 1;
    if (running > 0) transitions.set(target, running);
    else transitions.delete(target);
    lastTransition = performance.now();
    // Where it ended up.
    schedule();
  };

  const startListening = (): (() => void) => {
    const abort = new AbortController();
    const { signal } = abort;
    window.addEventListener('resize', schedule, { signal });
    // Scrolling does not bubble: it is caught on the way down, from any element that scrolls.
    document.addEventListener('scroll', schedule, { signal, capture: true, passive: true });
    document.addEventListener('transitionrun', onTransitionRun, { signal });
    document.addEventListener('transitionend', onTransitionStop, { signal });
    document.addEventListener('transitioncancel', onTransitionStop, { signal });
    // The UI scale (zoom) and the tokens (the radius) are set on the root (useAppearance).
    const root = new MutationObserver(() => schedule());
    root.observe(document.documentElement, { attributes: true });
    const unwatch = watch?.(schedule);
    return () => {
      abort.abort();
      root.disconnect();
      unwatch?.();
      transitions.clear();
    };
  };

  const add = (source: RectSource): (() => void) => {
    sources.push(source);
    resizes?.observe(source.element);
    stopListening ??= startListening();
    schedule();
    return () => {
      const index = sources.indexOf(source);
      if (index < 0) return;
      sources.splice(index, 1);
      if (!sources.some(({ element }) => element === source.element)) resizes?.unobserve(source.element);
      // The list without it (empty when it was the last).
      schedule();
    };
  };

  return { add, schedule };
}

/** The glass over the video: what the shader in mpv blurs. */
export const glassRegions = createRectSet({
  send: glassSetRegions,
  what: 'glass_set_regions',
  cap: MAX_REGIONS,
  enabled: () => useUiStore.getState().glass.enabled,
  watch: (changed) =>
    useUiStore.subscribe((state, previous) => {
      if (state.glass.enabled !== previous.glass.enabled) changed();
    }),
});

/**
 * Keeps `ref`'s element in `set` while it is mounted and `active`. For an element that is always
 * rendered while the component is: the ref is read when the effect runs.
 */
export function useTrackedRect(
  set: RectSet,
  ref: RefObject<HTMLElement | null>,
  radius?: number,
  active = true,
): void {
  useEffect(() => {
    const element = ref.current;
    if (!active || !element) return undefined;
    return set.add({ element, radius });
  }, [set, ref, radius, active]);
}

/**
 * Puts the element of `ref` among the glass regions over the video while it is mounted and
 * `active` (an element that is over the page, not the video, needs none). `radius` is its corner
 * radius in its own CSS px; left out, its border radius is read, so that the radius setting needs
 * nothing here.
 */
export function useGlassRegion(ref: RefObject<HTMLElement | null>, radius?: number, active = true): void {
  useTrackedRect(glassRegions, ref, radius, active);
}
