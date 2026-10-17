/**
 * The playback time for drawing: between two `time-pos` updates (10 a second at most) it runs on
 * by itself at the playback speed, so the seekbar moves smoothly.
 *
 * The animation-frame loop exists only while a component uses the hook and the player is playing.
 * Controls that are hidden do not use it, so they cost nothing (spec 13), and a paused player
 * redraws nothing.
 */

import { useEffect, useState } from 'react';

import {
  selectDuration,
  selectPlaying,
  selectSpeed,
  selectTimePos,
  usePlayerStore,
} from './playerStore';

/** `time` as it ran on from `anchor`, the `time-pos` it started from. */
type Running = { anchor: number; time: number };

/** Seconds into the file, running on between updates while playing; never past the duration. */
export function useInterpolatedTime(): number {
  const timePos = usePlayerStore((state) => selectTimePos(state.props));
  const duration = usePlayerStore((state) => selectDuration(state.props));
  const speed = usePlayerStore((state) => selectSpeed(state.props));
  const playing = usePlayerStore((state) => selectPlaying(state.props));
  const [running, setRunning] = useState<Running>({ anchor: timePos, time: timePos });

  useEffect(() => {
    if (!playing) return undefined;
    const startedAt = performance.now();
    let frame = 0;
    const tick = () => {
      const elapsed = Math.max(0, performance.now() - startedAt) / 1000;
      const ran = timePos + elapsed * speed;
      const time = duration > 0 ? Math.min(ran, Math.max(duration, timePos)) : ran;
      // The same time (the end of the file) draws nothing.
      setRunning((was) => (was.anchor === timePos && was.time === time ? was : { anchor: timePos, time }));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [playing, timePos, speed, duration]);

  // A new `time-pos` is the truth from the first render on; the loop catches up with it a frame
  // later, so the time never jumps ahead of it.
  return playing && running.anchor === timePos ? running.time : timePos;
}
