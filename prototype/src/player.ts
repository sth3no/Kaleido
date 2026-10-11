import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type PropValue = boolean | number | string | null;

export type PlayerCmd =
  | { type: 'togglePause' }
  | { type: 'seekAbsolute'; seconds: number }
  | { type: 'setVolume'; value: number }
  | { type: 'setFullscreen'; on: boolean };

export type Layout =
  | { kind: 'full' }
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'hidden' };

export const openFile = (path: string) => invoke<void>('open_file', { path });
export const playerCommand = (cmd: PlayerCmd) => invoke<void>('player_command', { cmd });
export const setSurfaceLayout = (layout: Layout) => invoke<void>('surface_set_layout', { layout });

export const onProp = (cb: (name: string, value: PropValue) => void): Promise<UnlistenFn> =>
  listen<{ name: string; value: PropValue }>('player:prop', (e) => cb(e.payload.name, e.payload.value));

export const onMessage = (cb: (args: string[]) => void): Promise<UnlistenFn> =>
  listen<string[]>('player:message', (e) => cb(e.payload));
