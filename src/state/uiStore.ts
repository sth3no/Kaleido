/**
 * What the UI itself keeps: the page, the sidebar, the panel above the controls, whether the
 * controls are hidden for want of movement, and whether the glass is on. The player's state is in
 * `playerStore`.
 */

import { create } from 'zustand';

import type { GlassState } from '../ipc/types';

export type Page = 'player' | 'plugins' | 'settings';
export type Panel = 'quick-settings' | 'playlist';
/** `quality` is for a link (an http(s) `path`); quick settings has no such tab for a file. */
export type QuickTab = 'subtitles' | 'audio' | 'quality';
export type FocusRequest = 'play';

export interface UiState {
  page: Page;
  sidebarOpen: boolean;
  /** The panel open above the controls; `null` for none. */
  panel: Panel | null;
  /** The tab quick settings opens on. */
  quickTab: QuickTab;
  /**
   * The islands are hidden because the pointer and the keyboard were still for 2.5 s while the
   * video plays (`useAutohide`). The shell fades its own islands by it.
   */
  controlsHidden: boolean;
  /**
   * Whether the glass over the video is on (`glass:state`; the bridge also asks once at start).
   * While it is off the panels are opaque. It starts on, as Rust does.
   */
  glass: GlassState;
  /**
   * A control that should take the focus when it next shows: `play`, the player's play and pause
   * button (the mini player's "Back to player" pressed with the keyboard asks for it). The control
   * clears it when it has the focus.
   */
  focusRequest: FocusRequest | null;
  setPage: (page: Page) => void;
  setSidebarOpen: (open: boolean) => void;
  setPanel: (panel: Panel | null) => void;
  setQuickTab: (tab: QuickTab) => void;
  setControlsHidden: (hidden: boolean) => void;
  setGlass: (glass: GlassState) => void;
  setFocusRequest: (request: FocusRequest | null) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  page: 'player',
  sidebarOpen: false,
  panel: null,
  quickTab: 'subtitles',
  controlsHidden: false,
  glass: { enabled: true, reason: null },
  focusRequest: null,
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
  setControlsHidden: (controlsHidden) => {
    set({ controlsHidden });
  },
  setGlass: (glass) => {
    set({ glass });
  },
  setFocusRequest: (focusRequest) => {
    set({ focusRequest });
  },
}));
