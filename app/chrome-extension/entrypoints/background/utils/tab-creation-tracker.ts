/**
 * Track the creation time of every tab Chrome reports via tabs.onCreated.
 *
 * Used by chrome_close_tabs_matching's `olderThanMs` filter (IMP-0050).
 * Tabs that were already open before this listener attached (e.g. tabs
 * that pre-dated a service-worker cold boot) do NOT have a recorded
 * creation time — the filter simply doesn't match them, which is the
 * documented behavior. We don't try to back-fill via chrome.tabs.query
 * because the resulting Tab record doesn't include a wall-clock
 * timestamp, and we don't want to silently report "now" as the
 * creation time for an old tab.
 */

const createdAtByTabId = new Map<number, number>();

let listenersAttached = false;

export function initTabCreationTracker(): void {
  if (listenersAttached) return;
  listenersAttached = true;

  chrome.tabs.onCreated.addListener((tab) => {
    if (typeof tab.id === 'number') {
      createdAtByTabId.set(tab.id, Date.now());
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    createdAtByTabId.delete(tabId);
  });
}

export function getTabCreatedAt(tabId: number): number | undefined {
  return createdAtByTabId.get(tabId);
}

/** Test-only — reset the in-memory state between cases. */
export function _resetTabCreationTrackerForTest(): void {
  createdAtByTabId.clear();
  listenersAttached = false;
}

/** Test-only — seed a creation timestamp without going through onCreated. */
export function _setTabCreatedAtForTest(tabId: number, createdAt: number): void {
  createdAtByTabId.set(tabId, createdAt);
}
