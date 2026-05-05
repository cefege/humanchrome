/**
 * Per-client tab/window preferences.
 *
 * Why this exists
 * ---------------
 * Chrome only allows one native-messaging port per extension, so all MCP
 * clients (Claude Code, curl, ChatGPT, …) share the same channel. The single
 * global `nativePort` plus the active-tab fallback in ~37 tools means two
 * clients calling tools without an explicit `tabId` would collide on
 * whichever tab was UI-active — and silently scribble over each other.
 *
 * This module keeps a small `Map<clientId, ClientState>` so each MCP session
 * has its own preferred-tab memory. `resolveTabIdForClient` is the only
 * touchpoint individual tools care about; it returns:
 *
 *   1. The explicit `tabId` if the caller passed one (highest precedence).
 *   2. The client's last-used tab if it still exists.
 *   3. `undefined` — caller falls back to the existing active-tab path.
 *
 * State is in-memory; service-worker restarts clear it. That's intentional —
 * client preferences are an optimization, not a contract.
 */

interface ClientState {
  lastTabId?: number;
  lastWindowId?: number;
  lastSeenAt: number;
}

const STATE = new Map<string, ClientState>();

/**
 * Drop client entries we haven't heard from in a while so dead sessions
 * don't pin tab ids forever.
 */
const STALE_AFTER_MS = 30 * 60 * 1000; // 30 min

function gc(now: number): void {
  for (const [id, s] of STATE) {
    if (now - s.lastSeenAt > STALE_AFTER_MS) STATE.delete(id);
  }
}

// Reactive invalidation: when a tab closes, drop it from every client's
// preference. This is the alternative to calling `chrome.tabs.get` on every
// implicit tool call to validate the cached id — that path costs an IPC per
// call; this listener costs O(clients) once per tab close.
try {
  chrome.tabs?.onRemoved?.addListener((closedTabId) => {
    for (const s of STATE.values()) {
      if (s.lastTabId === closedTabId) s.lastTabId = undefined;
    }
  });
} catch {
  // non-extension test context — listener is best-effort
}

export function recordClientTab(
  clientId: string | undefined,
  tabId: number,
  windowId?: number,
): void {
  if (!clientId || typeof tabId !== 'number') return;
  const now = Date.now();
  gc(now);
  const existing = STATE.get(clientId) ?? { lastSeenAt: now };
  existing.lastTabId = tabId;
  if (typeof windowId === 'number') existing.lastWindowId = windowId;
  existing.lastSeenAt = now;
  STATE.set(clientId, existing);
}

export function recordClientWindow(clientId: string | undefined, windowId: number): void {
  if (!clientId || typeof windowId !== 'number') return;
  const now = Date.now();
  const existing = STATE.get(clientId) ?? { lastSeenAt: now };
  existing.lastWindowId = windowId;
  existing.lastSeenAt = now;
  STATE.set(clientId, existing);
}

/**
 * Decide which tab a client's tool call should target.
 *
 * Explicit > preferred > undefined. Closed tabs are evicted reactively
 * via the `chrome.tabs.onRemoved` listener above, so we don't pay an
 * IPC per call to validate the cached id.
 */
export function resolveTabIdForClient(
  clientId: string | undefined,
  explicitTabId?: number,
): number | undefined {
  if (typeof explicitTabId === 'number') return explicitTabId;
  if (!clientId) return undefined;
  return STATE.get(clientId)?.lastTabId;
}

/**
 * Same shape as `resolveTabIdForClient` but for windowId. Used by
 * `chrome_navigate` and `chrome_navigate_batch` so that once a client has
 * touched a tab in window X, fan-out from that client lands in window X by
 * default — no more silent drift to a different window via `getLastFocused`.
 */
export function resolveWindowIdForClient(
  clientId: string | undefined,
  explicitWindowId?: number,
): number | undefined {
  if (typeof explicitWindowId === 'number') return explicitWindowId;
  if (!clientId) return undefined;
  return STATE.get(clientId)?.lastWindowId;
}

export function getClientState(clientId: string | undefined): ClientState | undefined {
  if (!clientId) return undefined;
  return STATE.get(clientId);
}

/** Test helper. Not exported via the barrel intentionally. */
export function _resetClientStateForTests(): void {
  STATE.clear();
}
