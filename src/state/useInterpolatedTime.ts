/**
 * The playback time for drawing: between two `time-pos` updates (10 a second at most) it runs on
 * by itself at the playback speed, so the seekbar moves smoothly.
 *
 * The animation-frame loop exists only while a component uses the hook and the player is playing.
 * Controls that are hidden do not use it, so they cost nothing (spec 13), and a paused player
 * redraws nothing.
 *
 * The time never goes back by itself. A new `time-pos` is the truth and replaces it; without one
 * (a pause, a change of speed) the time stays where it has run to, and starts from there again.
 */

import { useEffect, useRef, useState } from 'react';

import {
  selectDuration,
  selectPlaying,
  selectSpeed,
  selectTimePos,
  usePlayerStore,
} from './playerStore';

/** Seconds into the file, running on between updates while playing; never past the duration. */
export function useInterpolatedTime(): number {
  const timePos = usePlayerStore((state) => selectTimePos(state.props));
  const duration = usePlayerStore((state) => selectDuration(state.props));
  const speed = usePlayerStore((state) => selectSpeed(state.props));
  const playing = usePlayerStore(selectPlaying);
  const [time, setTime] = useState(timePos);
  const [anchor, setAnchor] = useState(timePos);

  // A new `time-pos` is where the time is from now on. Set while rendering, so that the old time
  // is never drawn next to it.
  const changed = anchor !== timePos;
  if (changed) {
    setAnchor(timePos);
    setTime(timePos);
  }

  // Where the loop starts from: the time as it was last drawn.
  const drawn = useRef(time);
  useEffect(() => {
    drawn.current = time;
  }, [time]);

  useEffect(() => {
    if (!playing) return undefined;
    const from = drawn.current;
    const startedAt = performance.now();
    let frame = 0;
    const tick = () => {
      const elapsed = Math.max(0, performance.now() - startedAt) / 1000;
      const ran = from + elapsed * speed;
      setTime(duration > 0 ? Math.min(ran, Math.max(duration, from)) : ran);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [playing, timePos, speed, duration]);

  return changed ? timePos : time;
}
