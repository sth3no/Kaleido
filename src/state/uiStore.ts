/**
 * What the UI itself keeps: the page, the sidebar, the panel above the controls, and whether
 * the glass is on. The player's state is in `playerStore`.
 */

import { create } from 'zustand';

import type { GlassState } from '../ipc/types';

export type Page = 'player' | 'settings';
export type Panel = 'quick-settings' | 'playlist';
export type QuickTab = 'subtitles' | 'audio';

export interface UiState {
  page: Page;
  sidebarOpen: boolean;
  /** The panel open above the controls; `null` for none. */
  panel: Panel | null;
  /** The tab quick settings opens on. */
  quickTab: QuickTab;
  /**
   * Whether the glass over the video is on (`glass:state`; the bridge also asks once at start).
   * While it is off the panels are opaque. It starts on, as Rust does.
   */
  glass: GlassState;
  setPage: (page: Page) => void;
  setSidebarOpen: (open: boolean) => void;
  setPanel: (panel: Panel | null) => void;
  setQuickTab: (tab: QuickTab) => void;
  setGlass: (glass: GlassState) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  page: 'player',
  sidebarOpen: false,
  panel: null,
  quickTab: 'subtitles',
  glass: { enabled: true, reason: null },
  setPage: (page) => {
    set({ page });
  },
  setSidebarOpen: (sidebarOpen) => {
    set({ sidebarOpen });
  },
  setPanel: (panel) => {
    set({ panel });
  },
  setQuickTab: (quickTab) => {
    set({ quickTab });
  },
  setGlass: (glass) => {
    set({ glass });
  },
}));
