import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { onProp } from './player';
import { applyProp, initialState, type PlayerState } from './playerState';

export function usePlayer(): PlayerState {
  const [state, setState] = useState(initialState);
  useEffect(() => {
    const subscriptions = [
      onProp((name, value) => setState((s) => applyProp(s, name, value))),
      listen('player:file-loaded', () => setState((s) => ({ ...s, loaded: true }))),
      listen<string>('player:log', (e) => console.warn(e.payload)),
    ];
    return () => {
      subscriptions.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);
  return state;
}
