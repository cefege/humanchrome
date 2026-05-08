/**
 * Last-tab guard — prevents the catastrophic failure mode where closing the
 * last tab in a window closes the whole Chrome window. If that was Chrome's
 * only window, Chrome itself quits, the MV3 service worker dies, native
 * messaging tears down, and every subsequent humanchrome tool call fails
 * until the user manually relaunches Chrome.
 *
 * Strategy:
 * 1. Before closing a tab, check if it's the only tab in its window. If so,
 *    open a placeholder `chrome://newtab` first, track its id, then close
 *    the original.
 * 2. The placeholder is purely a fail-safe and gets auto-cleaned the moment
 *    any other tab opens in the same window — `chrome.tabs.onCreated` listener
 *    notices and removes it.
 * 3. If the user closes the placeholder themselves, drop the tracking entry.
 *    If the window goes away entirely, drop everything for that window.
 *
 * Public surface:
 *   - `safeRemoveTabs(tabIds)` — drop-in replacement for `chrome.tabs.remove`
 *   - `initLastTabGuardListeners()` — call once at service-worker startup
 */

const PLACEHOLDER_URL = 'chrome://newtab/';

// One placeholder per window at most. Map<windowId, placeholderTabId>.
const placeholderByWindow = new Map<number, number>();

/**
 * Group tab ids by window id. Drops tabs that don't exist (e.g., the user
 * closed them between the caller's lookup and our remove call) — those are
 * already gone, no guard needed.
 */
async function groupByWindow(tabIds: number[]): Promise<Map<number, number[]>> {
  const grouped = new Map<number, number[]>();
  await Promise.all(
    tabIds.map(async (tabId) => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (typeof tab.windowId !== 'number') return;
        const list = grouped.get(tab.windowId) ?? [];
        list.push(tabId);
        grouped.set(tab.windowId, list);
      } catch {
        // Tab gone — skip silently. chrome.tabs.remove would throw the same
        // way; callers already handle that case for non-last-tab removes.
      }
    }),
  );
  return grouped;
}

/**
 * Open a placeholder tab in the given window and track it. Returns the new
 * tab id so the caller can wait until creation completes before removing the
 * original tab — Chrome only counts the window as "alive" once the new tab
 * has registered with the tab system.
 */
async function openPlaceholder(windowId: number): Promise<number | undefined> {
  // Avoid duplicating a placeholder if one's already tracked for this window
  // (shouldn't happen in practice — close-last-tab and open-placeholder are
  // serialised — but guard anyway).
  const existing = placeholderByWindow.get(windowId);
  if (typeof existing === 'number') {
    try {
      await chrome.tabs.get(existing);
      return existing; // Still alive; reuse.
    } catch {
      placeholderByWindow.delete(windowId); // Stale; fall through to create.
    }
  }

  try {
    const created = await chrome.tabs.create({ windowId, url: PLACEHOLDER_URL, active: false });
    if (typeof created.id === 'number') {
      placeholderByWindow.set(windowId, created.id);
      return created.id;
    }
  } catch (e) {
    console.warn('[last-tab-guard] failed to create placeholder tab:', e);
  }
  return undefined;
}

/**
 * Drop-in replacement for `chrome.tabs.remove`. For any tab that would be
 * the last in its window, open a placeholder first. Always returns after
 * the underlying remove completes.
 */
export async function safeRemoveTabs(tabIds: number | number[]): Promise<void> {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  if (ids.length === 0) return;

  const grouped = await groupByWindow(ids);
  if (grouped.size === 0) {
    // All tabs already gone; nothing to do.
    return;
  }

  // For each window, decide whether the planned removals would empty it.
  for (const [windowId, idsInWindow] of grouped.entries()) {
    let tabsInWindow: chrome.tabs.Tab[];
    try {
      tabsInWindow = await chrome.tabs.query({ windowId });
    } catch {
      continue; // Window vanished mid-flight; let the underlying remove handle it.
    }
    const totalInWindow = tabsInWindow.length;
    const removingFromWindow = idsInWindow.length;
    if (removingFromWindow >= totalInWindow) {
      // Closing all tabs in this window — open a placeholder to keep the
      // window alive. Wait for the placeholder before removing anything.
      await openPlaceholder(windowId);
    }
  }

  // Now remove the originals. Chrome's overloads split single-id and array
  // forms, so dispatch explicitly to keep TS happy.
  if (Array.isArray(tabIds)) {
    await chrome.tabs.remove(ids);
  } else {
    await chrome.tabs.remove(ids[0]!);
  }
}

/**
 * Service-worker listeners. Idempotent — installs once per worker lifetime.
 * Call from background entrypoint at startup.
 */
let listenersInstalled = false;
export function initLastTabGuardListeners(): void {
  if (listenersInstalled) return;
  if (typeof chrome === 'undefined') return;
  if (!chrome.tabs?.onCreated || !chrome.tabs?.onRemoved || !chrome.windows?.onRemoved) return;

  // When any tab is created in a window that has a placeholder, AND the new
  // tab isn't the placeholder itself, close the placeholder. The window now
  // has at least one "real" tab so the fail-safe is no longer needed.
  chrome.tabs.onCreated.addListener((tab) => {
    if (typeof tab.id !== 'number' || typeof tab.windowId !== 'number') return;
    const placeholderId = placeholderByWindow.get(tab.windowId);
    if (typeof placeholderId !== 'number') return;
    if (tab.id === placeholderId) return; // Don't close yourself.
    placeholderByWindow.delete(tab.windowId);
    chrome.tabs.remove(placeholderId).catch((e) => {
      console.warn('[last-tab-guard] failed to clean up placeholder:', e);
    });
  });

  // If the user closes the placeholder themselves (rare — they'd have to
  // beat the create listener), drop the tracking entry.
  chrome.tabs.onRemoved.addListener((tabId, info) => {
    const placeholderId = placeholderByWindow.get(info.windowId);
    if (placeholderId === tabId) {
      placeholderByWindow.delete(info.windowId);
    }
  });

  // If the window itself goes away (e.g., user closed it via Cmd-W on the
  // last tab before our guard had a chance, or chrome quit), drop the entry.
  chrome.windows.onRemoved.addListener((windowId) => {
    placeholderByWindow.delete(windowId);
  });

  listenersInstalled = true;
}

/**
 * Test/internal — exposes the placeholder map size + clear. Not intended for
 * normal callers; declared so tests can introspect without exporting state.
 */
export const __test = {
  placeholderCount: () => placeholderByWindow.size,
  hasPlaceholderFor: (windowId: number) => placeholderByWindow.has(windowId),
  reset: () => {
    placeholderByWindow.clear();
    listenersInstalled = false;
  },
};
