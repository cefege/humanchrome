/**
 * Per-client tab/window ownership and pacing state.
 *
 * Why this exists
 * ---------------
 * Chrome only allows one native-messaging port per extension, so all MCP
 * clients (Claude Code, curl, ChatGPT, ...) share the same channel. Two
 * clients calling tools without an explicit `tabId` would otherwise both
 * fall through to the globally-active tab and silently scribble over each
 * other.
 *
 * This module keeps a small `Map<clientId, ClientState>` so each MCP session
 * has its own owned-tab set. The dispatcher (`tools/index.ts`) uses
 * `resolveOwnedTabIdForClient` to pick a target tab before invoking the
 * tool — for mutating tools we never fall back to the global active tab;
 * instead the dispatcher auto-spawns a fresh tab the client owns.
 *
 * Ownership rules:
 *   - A client owns a tab if it opened the tab (auto-claim on create) or
 *     if it explicitly claimed an unowned tab (`browser_claim_tab` /
 *     explicit `tabId`).
 *   - Tabs the user opened manually in Chrome start out unowned.
 *   - Mutating tools targeting an owned-by-someone-else tab error with
 *     `TAB_NOT_OWNED`. Read-only tools may read any tab.
 *   - On `chrome.tabs.onRemoved` the tabId is dropped from every client's
 *     owned set.
 *   - On `releaseClient` (client transport closed) the client's owned tabs
 *     become unowned — they are NOT closed; the user keeps the browser.
 *
 * Identity persists across SW restart via `chrome.storage.session`. A
 * reconnecting MCP client that supplies the same `sessionName` (and thus
 * the same clientId at the bridge) reclaims its previous owned set.
 */

import { debugLog } from './debug-log';

export type PacingProfile = 'off' | 'human' | 'careful' | 'fast';

interface PacingState {
  profile: PacingProfile;
  /** Inclusive lower bound on gap between mutating dispatches (ms). */
  minGapMs: number;
  /** Random extra gap added to minGapMs, in [0, jitterMs] (ms). */
  jitterMs: number;
  /** Wall clock of the last dispatch the throttle let through. */
  lastDispatchAt: number;
}

interface ClientState {
  /** Tabs this client opened or explicitly claimed. */
  ownedTabs: Set<number>;
  /** Last tab this client acted on (must be in `ownedTabs`). */
  activeTabId?: number;
  /** Most-recently-acted window for this client. */
  lastWindowId?: number;
  lastSeenAt: number;
  pacing?: PacingState;
}

/**
 * Profile presets. `off` is current behavior (no throttle). `human` mimics a
 * person clicking around; `careful` adds a wide jitter band for sites that
 * detect rhythm (LinkedIn, Instagram); `fast` keeps tab-lock serialization
 * but adds no extra wait — useful when the agent is exercising read-mostly
 * surfaces.
 */
const PROFILE_DEFAULTS: Record<
  Exclude<PacingProfile, 'off'>,
  { minGapMs: number; jitterMs: number }
> = {
  human: { minGapMs: 600, jitterMs: 600 },
  careful: { minGapMs: 1500, jitterMs: 1500 },
  fast: { minGapMs: 0, jitterMs: 0 },
};

const STATE = new Map<string, ClientState>();

/**
 * Drop client entries we haven't heard from in a while so dead sessions
 * don't pin tab ids forever. This is a safety net for the case where a
 * bridge disconnect signal is dropped (native-host crash, etc.).
 */
const STALE_AFTER_MS = 30 * 60 * 1000; // 30 min

/** Key for the persisted ownership snapshot in chrome.storage.session. */
const STORAGE_KEY = 'humanchrome:ownership';

/** Debounce window for storage.session writes. */
const PERSIST_DEBOUNCE_MS = 50;

function gc(now: number): void {
  for (const [id, s] of STATE) {
    if (now - s.lastSeenAt > STALE_AFTER_MS) STATE.delete(id);
  }
}

function ensureState(clientId: string, now: number): ClientState {
  let s = STATE.get(clientId);
  if (!s) {
    s = { ownedTabs: new Set<number>(), lastSeenAt: now };
    STATE.set(clientId, s);
  }
  return s;
}

// =============================================================================
// Persistence to chrome.storage.session
// =============================================================================

interface PersistedClientEntry {
  ownedTabIds: number[];
  activeTabId?: number;
  lastWindowId?: number;
  lastSeenAt: number;
}

type PersistedSnapshot = Record<string, PersistedClientEntry>;

let persistTimer: ReturnType<typeof setTimeout> | undefined;

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

async function persistNow(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
  const snapshot: PersistedSnapshot = {};
  for (const [clientId, s] of STATE) {
    // Don't persist UI-synthetic ids — they don't survive Chrome restart
    // meaningfully and they're cheap to recreate. Don't persist anonymous
    // UUID clientIds either (they can't reconnect).
    if (s.ownedTabs.size === 0) continue;
    snapshot[clientId] = {
      ownedTabIds: Array.from(s.ownedTabs),
      activeTabId: s.activeTabId,
      lastWindowId: s.lastWindowId,
      lastSeenAt: s.lastSeenAt,
    };
  }
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: snapshot });
  } catch (err) {
    debugLog.warn('client-state persist failed', {
      data: { err: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Restore the ownership map from chrome.storage.session. Called once at
 * SW boot from native-host.ts. Cross-checks every tabId against
 * `chrome.tabs.query({})` — tabs that no longer exist are dropped.
 */
export async function loadPersistedClientState(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
  let raw: PersistedSnapshot | undefined;
  try {
    const got = await chrome.storage.session.get(STORAGE_KEY);
    raw = got?.[STORAGE_KEY] as PersistedSnapshot | undefined;
  } catch {
    return;
  }
  if (!raw || typeof raw !== 'object') return;

  let aliveTabIds = new Set<number>();
  try {
    const tabs = await chrome.tabs.query({});
    aliveTabIds = new Set(
      tabs.map((t) => t.id).filter((id): id is number => typeof id === 'number'),
    );
  } catch {
    // Best-effort — if we can't enumerate tabs, trust the snapshot. The
    // first `onRemoved` will reconcile.
  }

  const now = Date.now();
  for (const [clientId, entry] of Object.entries(raw)) {
    if (!entry || !Array.isArray(entry.ownedTabIds)) continue;
    const liveTabIds = entry.ownedTabIds.filter(
      (id) => typeof id === 'number' && (aliveTabIds.size === 0 || aliveTabIds.has(id)),
    );
    if (liveTabIds.length === 0) continue;
    const s: ClientState = {
      ownedTabs: new Set(liveTabIds),
      activeTabId:
        typeof entry.activeTabId === 'number' && liveTabIds.includes(entry.activeTabId)
          ? entry.activeTabId
          : undefined,
      lastWindowId: typeof entry.lastWindowId === 'number' ? entry.lastWindowId : undefined,
      lastSeenAt: typeof entry.lastSeenAt === 'number' ? entry.lastSeenAt : now,
    };
    STATE.set(clientId, s);
  }
  debugLog.info('client-state restored', {
    data: { clients: STATE.size },
  });
}

// =============================================================================
// Pacing (unchanged behavior, same public surface)
// =============================================================================

export function setClientPacing(
  clientId: string | undefined,
  profile: PacingProfile,
  overrides?: { minGapMs?: number; jitterMs?: number },
): PacingState | undefined {
  if (!clientId) return undefined;
  const now = Date.now();
  const existing = ensureState(clientId, now);
  if (profile === 'off') {
    delete existing.pacing;
  } else {
    const defaults = PROFILE_DEFAULTS[profile];
    existing.pacing = {
      profile,
      minGapMs: overrides?.minGapMs ?? defaults.minGapMs,
      jitterMs: overrides?.jitterMs ?? defaults.jitterMs,
      lastDispatchAt: 0,
    };
  }
  existing.lastSeenAt = now;
  return existing.pacing ? { ...existing.pacing } : undefined;
}

export function getClientPacing(clientId: string | undefined): PacingState | undefined {
  if (!clientId) return undefined;
  return STATE.get(clientId)?.pacing;
}

/**
 * Compute and consume the next throttle delay for `clientId`. Returns the
 * number of ms the caller should sleep before dispatching, and updates
 * `lastDispatchAt` to (now + delay) so back-to-back calls compound.
 */
export function consumePacingDelay(clientId: string | undefined): number {
  if (!clientId) return 0;
  const state = STATE.get(clientId);
  const pacing = state?.pacing;
  if (!state || !pacing) return 0;
  const now = Date.now();
  const elapsed = now - pacing.lastDispatchAt;
  const target = pacing.minGapMs + Math.floor(Math.random() * (pacing.jitterMs + 1));
  const delay = Math.max(0, target - elapsed);
  pacing.lastDispatchAt = now + delay;
  state.lastSeenAt = now;
  return delay;
}

// =============================================================================
// Ownership API
// =============================================================================

/**
 * Add `tabId` to `clientId`'s owned set and make it the active tab. If
 * another client owned the tab, transfer ownership and return the previous
 * owner — caller (e.g. `browser_claim_tab`) decides what to do with that
 * information. When `windowId` is provided it's recorded too.
 */
export function claimTabForClient(
  clientId: string | undefined,
  tabId: number,
  windowId?: number,
): string | null {
  if (!clientId || typeof tabId !== 'number' || !Number.isFinite(tabId)) return null;
  const now = Date.now();
  gc(now);
  let previousOwner: string | null = null;
  for (const [otherId, otherState] of STATE) {
    if (otherId === clientId) continue;
    if (otherState.ownedTabs.delete(tabId)) {
      previousOwner = otherId;
      if (otherState.activeTabId === tabId) otherState.activeTabId = undefined;
    }
  }
  const state = ensureState(clientId, now);
  state.ownedTabs.add(tabId);
  state.activeTabId = tabId;
  if (typeof windowId === 'number') state.lastWindowId = windowId;
  state.lastSeenAt = now;
  schedulePersist();
  return previousOwner;
}

/**
 * Drop `tabId` from `clientId`'s owned set. No-op if the client didn't
 * own it.
 */
export function releaseTabFromClient(clientId: string | undefined, tabId: number): void {
  if (!clientId) return;
  const state = STATE.get(clientId);
  if (!state) return;
  if (state.ownedTabs.delete(tabId)) {
    if (state.activeTabId === tabId) state.activeTabId = undefined;
    schedulePersist();
  }
}

/**
 * Find the clientId currently owning `tabId`, or `null` if the tab is
 * unowned. Returns the first match; ownership is exclusive so there
 * should be at most one.
 */
export function findTabOwner(tabId: number): string | null {
  for (const [clientId, state] of STATE) {
    if (state.ownedTabs.has(tabId)) return clientId;
  }
  return null;
}

/**
 * Release every tab owned by `clientId` back to the unowned pool. The
 * client entry itself stays (with `lastSeenAt` updated) so a reconnect
 * under the same sessionName can re-establish from the persisted snapshot.
 *
 * Does NOT close the tabs — the user keeps the browser session intact.
 */
export function releaseClient(clientId: string | undefined): number {
  if (!clientId) return 0;
  const state = STATE.get(clientId);
  if (!state) return 0;
  const released = state.ownedTabs.size;
  state.ownedTabs.clear();
  state.activeTabId = undefined;
  state.lastSeenAt = Date.now();
  schedulePersist();
  return released;
}

export interface ResolveOptions {
  /** When true (read-only tools), allow resolution to any tab regardless of ownership. */
  isRead?: boolean;
}

export interface ResolveResult {
  /** Resolved tab id, or undefined if none could be picked. */
  tabId?: number;
  /**
   * Set when an explicit `tabId` was rejected because another client owns it.
   * The dispatcher converts this into a `TAB_NOT_OWNED` ToolError.
   */
  conflict?: { tabId: number; owner: string };
}

/**
 * Pick a target tab for a call.
 *
 * Priority:
 *   1. Explicit `tabId` from the caller.
 *      - For mutating tools: must be unowned (auto-claim) or already owned by
 *        the calling client. Otherwise returns `conflict`.
 *      - For read-only tools: always accepted; ownership unchanged.
 *   2. Client's `activeTabId` (if still in `ownedTabs`).
 *   3. Most recently added entry in `ownedTabs`.
 *   4. `undefined` — caller (dispatcher) decides whether to auto-spawn.
 *
 * Closed tabs are evicted reactively via `chrome.tabs.onRemoved` below,
 * so we don't pay an IPC per call to validate the cached id.
 */
export function resolveOwnedTabIdForClient(
  clientId: string | undefined,
  explicitTabId?: number,
  opts: ResolveOptions = {},
): ResolveResult {
  if (typeof explicitTabId === 'number') {
    if (opts.isRead) return { tabId: explicitTabId };
    const owner = findTabOwner(explicitTabId);
    if (owner && owner !== clientId) {
      return { conflict: { tabId: explicitTabId, owner } };
    }
    // Unowned or owned by us — auto-claim/refresh.
    if (clientId) claimTabForClient(clientId, explicitTabId);
    return { tabId: explicitTabId };
  }
  if (!clientId) return {};
  const state = STATE.get(clientId);
  if (!state) return {};
  if (typeof state.activeTabId === 'number' && state.ownedTabs.has(state.activeTabId)) {
    return { tabId: state.activeTabId };
  }
  // Pick the most-recently-inserted owned tab as a fallback. Set insertion
  // order is preserved in JavaScript, so the last `add` wins.
  let last: number | undefined;
  for (const id of state.ownedTabs) last = id;
  return last !== undefined ? { tabId: last } : {};
}

/**
 * Record a tab/window touched by this client. Used by the dispatcher after
 * a successful tool call to keep `activeTabId` / `lastWindowId` fresh. If
 * the tab isn't already owned, it's claimed.
 */
export function recordClientTab(
  clientId: string | undefined,
  tabId: number,
  windowId?: number,
): void {
  if (!clientId || typeof tabId !== 'number' || !Number.isFinite(tabId)) return;
  claimTabForClient(clientId, tabId, windowId);
}

export function recordClientWindow(clientId: string | undefined, windowId: number): void {
  if (!clientId || typeof windowId !== 'number') return;
  const now = Date.now();
  const existing = ensureState(clientId, now);
  existing.lastWindowId = windowId;
  existing.lastSeenAt = now;
  schedulePersist();
}

/**
 * Pick a windowId for the calling client. Explicit caller-supplied id wins;
 * otherwise the client's `lastWindowId` recency hint; otherwise `undefined`
 * (caller falls back to Chrome's last-focused selection).
 *
 * Synchronous — liveness of the returned windowId is verified by callers
 * that act on it (and by `chrome.windows.onRemoved`).
 */
export function resolveOwnedWindowIdForClient(
  clientId: string | undefined,
  explicitWindowId?: number,
): number | undefined {
  if (typeof explicitWindowId === 'number' && Number.isFinite(explicitWindowId)) {
    return explicitWindowId;
  }
  if (!clientId) return undefined;
  const state = STATE.get(clientId);
  return state?.lastWindowId;
}

/**
 * Clear a stale `lastWindowId` for a single client. Called by the dispatcher
 * when an auto-spawn probe (`chrome.windows.get`) discovers the recorded
 * window has died between the last touch and now.
 */
export function clearLastWindowForClient(clientId: string | undefined, windowId: number): void {
  if (!clientId) return;
  const state = STATE.get(clientId);
  if (!state) return;
  if (state.lastWindowId === windowId) {
    state.lastWindowId = undefined;
    schedulePersist();
  }
}

/**
 * Read-only accessor for diagnostics and `chrome_get_windows_and_tabs`.
 */
export function getClientState(clientId: string | undefined): ClientState | undefined {
  if (!clientId) return undefined;
  return STATE.get(clientId);
}

/** Test helper. Not exported via the barrel intentionally. */
export function _resetClientStateForTests(): void {
  STATE.clear();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
}

/**
 * Test helper — runs the same eviction logic the `chrome.tabs.onRemoved`
 * listener registered at module load runs. Used by tests that can't
 * exercise the listener directly (it's registered against the chrome
 * mock present at module load, not the per-test mock).
 */
export function _handleTabRemovedForTests(tabId: number): void {
  let touched = false;
  for (const s of STATE.values()) {
    if (s.ownedTabs.delete(tabId)) touched = true;
    if (s.activeTabId === tabId) {
      s.activeTabId = undefined;
      touched = true;
    }
  }
  if (touched) schedulePersist();
}

/**
 * Test helper — runs the same eviction logic the `chrome.windows.onRemoved`
 * listener registered at module load runs. Per-tab evictions happen via the
 * companion `chrome.tabs.onRemoved` path; this helper only nulls the
 * `lastWindowId` hint so the next auto-spawn doesn't pass a dead windowId.
 */
export function _handleWindowRemovedForTests(windowId: number): void {
  let touched = false;
  for (const s of STATE.values()) {
    if (s.lastWindowId === windowId) {
      s.lastWindowId = undefined;
      touched = true;
    }
  }
  if (touched) schedulePersist();
}

// =============================================================================
// chrome.tabs.onRemoved — evict closed tabs from every client's owned set
// =============================================================================

try {
  chrome.tabs?.onRemoved?.addListener((closedTabId) => {
    let touched = false;
    for (const s of STATE.values()) {
      if (s.ownedTabs.delete(closedTabId)) touched = true;
      if (s.activeTabId === closedTabId) {
        s.activeTabId = undefined;
        touched = true;
      }
    }
    if (touched) schedulePersist();
  });
} catch {
  // non-extension test context — listener is best-effort
}

// =============================================================================
// chrome.windows.onRemoved — null stale lastWindowId hints when a window dies
// =============================================================================

try {
  chrome.windows?.onRemoved?.addListener((closedWindowId) => {
    let touched = false;
    for (const s of STATE.values()) {
      if (s.lastWindowId === closedWindowId) {
        s.lastWindowId = undefined;
        touched = true;
      }
    }
    if (touched) schedulePersist();
  });
} catch {
  // non-extension test context — listener is best-effort
}
