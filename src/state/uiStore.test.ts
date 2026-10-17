import { beforeEach, expect, test } from 'vitest';

import { useUiStore } from './uiStore';

const store = useUiStore;

beforeEach(() => {
  store.setState(store.getInitialState(), true);
});

test('starts on the player with the sidebar and the panels closed, and the glass on', () => {
  expect(store.getState()).toMatchObject({
    page: 'player',
    sidebarOpen: false,
    panel: null,
    quickTab: 'subtitles',
    glass: { enabled: true, reason: null },
  });
});

test('the setters change one thing each', () => {
  store.getState().setPage('settings');
  store.getState().setSidebarOpen(true);
  store.getState().setPanel('quick-settings');
  store.getState().setQuickTab('audio');
  store.getState().setGlass({ enabled: false, reason: 'gpuFailure' });
  expect(store.getState()).toMatchObject({
    page: 'settings',
    sidebarOpen: true,
    panel: 'quick-settings',
    quickTab: 'audio',
    glass: { enabled: false, reason: 'gpuFailure' },
  });
  store.getState().setPanel(null);
  expect(store.getState().panel).toBeNull();
  expect(store.getState().quickTab).toBe('audio');
});
