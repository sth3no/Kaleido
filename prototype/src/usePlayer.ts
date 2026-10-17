import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { onProp } from './player';
import { applyProp, initialState, type PlayerState } from './playerState';

export function usePlayer(): PlayerState {
  const [state, setState] = useState(initialState);
  useEffect(() => {
    let disposed = false;
    const subscriptions = [
      onProp((name, value) => setState((s) => applyProp(s, name, value))),
      listen('player:file-loaded', () => setState((s) => ({ ...s, loaded: true }))),
      listen<string>('player:log', (e) => console.warn(e.payload)),
    ];
    void Promise.all(subscriptions)
      .then(() => { if (!disposed) return invoke('player_ready'); })
      .catch((error) => console.warn('player_ready', error));
    return () => {
      disposed = true;
      subscriptions.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);
  return state;
}
