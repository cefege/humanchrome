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
 * A single Rust-owned `BrowserState` keeps each MCP session's owned-tab set.
 * This module is only its Chrome/storage/timer adapter; the dispatcher asks
 * Rust to plan targets, including fresh background-tab creation for mutating
 * calls that have no usable owned tab.
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

import { browserPolicy } from 'humanchrome-shared';
import { debugLog } from './debug-log';
import { ensureRustKernel } from '@/shared/rust-kernel';

let readiness: Promise<void> | undefined;
let kernelReady = false;
let browserState: browserPolicy.RustBrowserState | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

const STORAGE_KEY = 'humanchrome:ownership';
const PERSIST_DEBOUNCE_MS = 50;

export type PacingProfile = 'off' | 'human' | 'careful' | 'fast';
export interface PacingState {
  profile: PacingProfile;
  minGapMs: number;
  jitterMs: number;
  lastDispatchAt: number;
}

/**
 * A caller-facing snapshot of Rust-owned client state. Collections are rebuilt
 * on demand and must never be retained as mutable state.
 */
export interface ClientState {
  ownedTabs: Set<number>;
  activeTabId?: number;
  lastWindowId?: number;
  lastSeenAt: number;
  pacing?: PacingState;
  aliases?: Map<string, number>;
}

/** One startup barrier: tool calls cannot race kernel loading or ownership restoration. */
export function ensureClientStateReady(): Promise<void> {
  readiness ??= ensureRustKernel().then(() => {
    kernelReady = true;
    getBrowserState();
    return loadPersistedClientState();
  });
  return readiness;
}

/**
 * Returns the sole Rust policy object after its owning realm has initialized.
 * Synchronous wrapper APIs intentionally remain synchronous; async entry
 * points must await `ensureClientStateReady` before using them.
 */
export function getBrowserStateForClientPolicy(): browserPolicy.RustBrowserState {
  return getBrowserState();
}

function getBrowserState(): browserPolicy.RustBrowserState {
  if (!browserState) {
    if (!kernelReady) {
      throw new Error('Client state is not ready; await ensureClientStateReady() first.');
    }
    browserState = new browserPolicy.RustBrowserState();
  }
  return browserState;
}

function now(): number {
  return Date.now();
}

function schedulePersistIfDirty(): void {
  if (!getBrowserState().persistenceDirty || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

async function persistNow(): Promise<void> {
  const state = getBrowserState();
  if (!state.persistenceDirty) return;
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: state.ownershipSnapshot() });
    state.markPersisted();
  } catch (err) {
    debugLog.warn('client-state persist failed', {
      data: { err: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Restores Rust-owned ownership state from the storage effect adapter.
 * Pacing intentionally remains ephemeral across service-worker restart.
 */
export async function loadPersistedClientState(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
  let snapshot: Record<string, unknown> | undefined;
  try {
    const got = await chrome.storage.session.get(STORAGE_KEY);
    const raw = got?.[STORAGE_KEY];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      snapshot = raw as Record<string, unknown>;
    }
  } catch {
    return;
  }
  if (!snapshot) return;

  let aliveTabIds: number[] | null = [];
  try {
    const tabs = await chrome.tabs.query({});
    aliveTabIds = tabs
      .map((tab) => tab.id)
      .filter((tabId): tabId is number => typeof tabId === 'number');
  } catch {
    // `null` preserves the existing best-effort "trust storage" behavior.
    aliveTabIds = null;
  }

  const report = getBrowserState().restoreOwnership(
    snapshot as browserPolicy.OwnershipSnapshot,
    aliveTabIds,
    now(),
  );
  debugLog.info('client-state restored', { data: { clients: report.restoredClients } });
}

export function setClientPacing(
  clientId: string | undefined,
  profile: PacingProfile,
  overrides?: { minGapMs?: number; jitterMs?: number },
): PacingState | undefined {
  return getBrowserState().setPacing(clientId, profile, overrides, now()) ?? undefined;
}

export function getClientPacing(clientId: string | undefined): PacingState | undefined {
  return getBrowserState().pacing(clientId) ?? undefined;
}

/** Computes pacing with explicit host clock and entropy. */
export function consumePacingDelay(clientId: string | undefined): number {
  return getBrowserState().consumePacingDelay(clientId, now(), Math.random());
}

export function claimTabForClient(
  clientId: string | undefined,
  tabId: number,
  windowId?: number,
): string | null {
  if (!clientId || !Number.isFinite(tabId)) return null;
  const previous = getBrowserState().claimTab(clientId, tabId, windowId, now());
  schedulePersistIfDirty();
  return previous;
}

export function releaseTabFromClient(clientId: string | undefined, tabId: number): void {
  if (getBrowserState().releaseTab(clientId, tabId)) schedulePersistIfDirty();
}

export function findTabOwner(tabId: number): string | null {
  return getBrowserState().tabOwner(tabId);
}

const clientReleasedSubscribers = new Set<(clientId: string) => void>();

export function subscribeOnClientReleased(cb: (clientId: string) => void): () => void {
  clientReleasedSubscribers.add(cb);
  return () => clientReleasedSubscribers.delete(cb);
}

export function releaseClient(clientId: string | undefined): number {
  const existed = clientId !== undefined && getBrowserState().clientSnapshot(clientId) !== null;
  const released = getBrowserState().releaseClient(clientId, now());
  if (existed && clientId) {
    schedulePersistIfDirty();
    for (const cb of clientReleasedSubscribers) {
      try {
        cb(clientId);
      } catch {
        // Release observers must not interfere with ownership state.
      }
    }
  }
  return released;
}

export interface ResolveOptions {
  isRead?: boolean;
}

export interface ResolveResult {
  tabId?: number;
  conflict?: { tabId: number; owner: string };
  aliasMiss?: { alias: string; reason: 'unknown-alias' | 'tab-closed' };
  conflictingArgs?: { tabId: number; alias: string };
}

export function resolveOwnedTabIdForClient(
  clientId: string | undefined,
  explicitTabId?: number,
  opts: ResolveOptions = {},
): ResolveResult {
  const resolved = getBrowserState().resolveOwnedTab(
    clientId,
    explicitTabId,
    opts.isRead ? 'read' : 'mutate',
    now(),
  );
  schedulePersistIfDirty();
  return resolutionSnapshot(resolved);
}

export function recordClientTab(
  clientId: string | undefined,
  tabId: number,
  windowId?: number,
): void {
  if (!clientId || !Number.isFinite(tabId)) return;
  getBrowserState().recordClientTab(clientId, tabId, windowId, now());
  schedulePersistIfDirty();
}

export function recordClientWindow(clientId: string | undefined, windowId: number): void {
  if (!clientId || !Number.isFinite(windowId)) return;
  getBrowserState().recordClientWindow(clientId, windowId, now());
  schedulePersistIfDirty();
}

export function resolveOwnedWindowIdForClient(
  clientId: string | undefined,
  explicitWindowId?: number,
): number | undefined {
  return getBrowserState().resolveOwnedWindow(clientId, explicitWindowId) ?? undefined;
}

export function clearLastWindowForClient(clientId: string | undefined, windowId: number): void {
  if (getBrowserState().clearLastWindow(clientId, windowId)) schedulePersistIfDirty();
}

/** Returns an immutable Rust snapshot converted into the legacy collection view. */
export function getClientState(clientId: string | undefined): ClientState | undefined {
  const snapshot = getBrowserState().clientSnapshot(clientId);
  return snapshot ? clientSnapshot(snapshot) : undefined;
}

export interface AliasResolveResult {
  tabId?: number;
  reason?: 'unknown-alias' | 'tab-closed';
}

export function isValidTabAlias(alias: string): boolean {
  return getBrowserState().isValidAlias(alias);
}

export function setAliasForClient(
  clientId: string | undefined,
  alias: string,
  tabId: number,
): { previousTabId?: number } {
  const previousTabId = getBrowserState().setAlias(clientId, alias, tabId, now());
  schedulePersistIfDirty();
  return previousTabId === null ? {} : { previousTabId };
}

export function resolveAliasForClient(
  clientId: string | undefined,
  alias: string,
): AliasResolveResult {
  const resolved = getBrowserState().resolveAlias(clientId, alias);
  if (typeof resolved.tabId === 'number') return { tabId: resolved.tabId };
  if (resolved.error) {
    schedulePersistIfDirty();
    return { reason: resolved.error.reason };
  }
  return { reason: 'unknown-alias' };
}

export function listAliasesForClient(clientId: string | undefined): Record<string, number> {
  return getBrowserState().aliases(clientId);
}

/** Test helper. Not exported via the barrel intentionally. */
export function _resetClientStateForTests(): void {
  readiness = undefined;
  browserState = undefined;
  clientReleasedSubscribers.clear();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
}

export function _handleTabRemovedForTests(tabId: number): void {
  if (getBrowserState().handleTabRemoved(tabId)) schedulePersistIfDirty();
}

export function _handleWindowRemovedForTests(windowId: number): void {
  if (getBrowserState().handleWindowRemoved(windowId)) schedulePersistIfDirty();
}

function clientSnapshot(snapshot: browserPolicy.ClientStateSnapshot): ClientState {
  return {
    ownedTabs: new Set(snapshot.ownedTabIds),
    activeTabId: snapshot.activeTabId,
    lastWindowId: snapshot.lastWindowId,
    lastSeenAt: snapshot.lastSeenAt,
    pacing: snapshot.pacing,
    aliases: snapshot.aliases ? new Map(Object.entries(snapshot.aliases)) : undefined,
  };
}

function resolutionSnapshot(resolved: {
  tabId?: number;
  error?: { code: string; details: unknown };
}): ResolveResult {
  if (typeof resolved.tabId === 'number') return { tabId: resolved.tabId };
  const details = resolved.error?.details as Record<string, unknown> | undefined;
  switch (resolved.error?.code) {
    case 'TAB_NOT_OWNED':
      return {
        conflict: {
          tabId: details?.tabId as number,
          owner: details?.owner as string,
        },
      };
    case 'TAB_NOT_FOUND':
      return {
        aliasMiss: {
          alias: details?.alias as string,
          reason: details?.reason as 'unknown-alias' | 'tab-closed',
        },
      };
    case 'INVALID_ARGS':
      return {
        conflictingArgs: {
          tabId: details?.tabId as number,
          alias: details?.alias as string,
        },
      };
    default:
      return {};
  }
}

// Register listeners synchronously; callback policy work waits for restoration.
try {
  chrome.tabs?.onRemoved?.addListener((closedTabId) => {
    void ensureClientStateReady()
      .then(() => _handleTabRemovedForTests(closedTabId))
      .catch(() => undefined);
  });
} catch {
  // Non-extension test context.
}

try {
  chrome.windows?.onRemoved?.addListener((closedWindowId) => {
    void ensureClientStateReady()
      .then(() => _handleWindowRemovedForTests(closedWindowId))
      .catch(() => undefined);
  });
} catch {
  // Non-extension test context.
}
