/**
 * What the panels read of mpv's properties (the store keeps them as they arrive, `unknown`), and
 * how they send what the user chose.
 */

import { playerCommand } from '../ipc/commands';
import type { PlayerCommand, TrackKind } from '../ipc/types';
import { selectTracks, type PlayerProps } from '../state/playerStore';

/** A finite number, else `fallback` (the property is not reported yet, or has no value). */
export function numberProp(props: PlayerProps, name: string, fallback: number): number {
  const value = props[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const TRACK_PROPERTY: Record<TrackKind, string> = { sub: 'sid', audio: 'aid', video: 'vid' };

/**
 * The id of the track of `kind` that plays; `null` for none. mpv's `no` arrives as `null`. Before
 * the property is reported, the track list says which one is selected.
 */
export function selectedTrackId(props: PlayerProps, kind: TrackKind): number | null {
  const reported = props[TRACK_PROPERTY[kind]];
  if (typeof reported === 'number' && Number.isFinite(reported)) return reported;
  if (reported === null) return null;
  return selectTracks(kind)(props).find((track) => track.selected === true)?.id ?? null;
}

/** Sends a command to the player; a refusal is for the log, the panel has nothing to correct. */
export function sendCommand(cmd: PlayerCommand): void {
  playerCommand(cmd).catch((error: unknown) => {
    console.warn('player_command', cmd.type, error);
  });
}
