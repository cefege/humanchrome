/**
 * `(clientId, tabId)`-keyed registry for per-tool module-scope state.
 *
 * Today, several browser tools keep their per-tab state in module-scope
 * `Map<tabId, V>` registries: inject-script (`injectedTabs`), userscript
 * (`activeInjections`), locator-handler (`tabHandlers`), dialog
 * (`defaults`), gif-auto-capture (`tabStates`), performance
 * (`sessions`/`LAST_RESULTS`), the three network-capture variants.
 * Keying by tabId alone means two clients sharing a tab can clobber
 * each other's entries.
 *
 * `OwnedRegistry<V>` keys by `(clientId, tabId)` instead and self-evicts
 * when (a) the tab closes via `chrome.tabs.onRemoved` or (b) the client
 * disconnects via `releaseClient` → `subscribeOnClientReleased`. Each
 * consumer supplies an optional `onEvict(entry)` callback so per-entry
 * resources (CDP detach, injection cancel, recorder teardown) get cleaned
 * up consistently rather than re-implemented per tool.
 *
 * Migration target — IMP-0162. This file lands first (IMP-0158) with no
 * callers so the data structure is reviewable in isolation.
 */

import { subscribeOnClientReleased } from './client-state';

/** A registry entry, surfaced to `onEvict` callbacks and `entries()`. */
export interface OwnedRegistryEntry<V> {
  clientId: string;
  tabId: number;
  value: V;
}

export interface OwnedRegistry<V> {
  get(clientId: string | undefined, tabId: number): V | undefined;
  set(clientId: string | undefined, tabId: number, value: V): void;
  delete(clientId: string | undefined, tabId: number): boolean;
  has(clientId: string | undefined, tabId: number): boolean;

  /** Iterate every `(clientId, tabId, value)` triple currently held. */
  entries(): IterableIterator<OwnedRegistryEntry<V>>;

  /** Total entry count across every client. */
  size(): number;

  /**
   * Drop every entry for `tabId` (any client). Returns the evicted entries
   * so the caller can fire its own teardown if `onEvict` isn't enough.
   * `onEvict` is called per evicted entry first.
   */
  forgetTab(tabId: number): OwnedRegistryEntry<V>[];

  /**
   * Drop every entry for `clientId`. Returns the evicted entries.
   * `onEvict` is called per evicted entry first.
   */
  forgetClient(clientId: string): OwnedRegistryEntry<V>[];

  /**
   * Tear down the registry: unsubscribe from `chrome.tabs.onRemoved` and
   * `subscribeOnClientReleased`. Useful in tests; rarely needed at runtime
   * since registries live for the SW lifetime.
   */
  dispose(): void;
}

export interface CreateOwnedRegistryOptions<V> {
  /**
   * Called once per evicted entry (tab-close, client-release, explicit
   * `delete` / `forgetTab` / `forgetClient`). Use for per-entry resource
   * cleanup. Errors are swallowed so one bad teardown can't block others.
   */
  onEvict?: (entry: OwnedRegistryEntry<V>) => void;

  /**
   * Test escape hatch: skip subscribing to chrome.tabs.onRemoved and the
   * client-released hook. Tests that want to exercise eviction manually
   * can drive it via `forgetTab` / `forgetClient`.
   */
  skipAutoSubscribe?: boolean;
}

// Reserved synthetic clientId for callsites that legitimately have no
// request context (e.g. SW event handlers reacting to chrome events).
// Entries written under this key are visible only to debug-dump style
// inspection — runtime lookups should always carry a real clientId.
const SYSTEM_CLIENT = '__system';

function resolveClientId(clientId: string | undefined): string {
  return clientId && clientId.length > 0 ? clientId : SYSTEM_CLIENT;
}

export function createOwnedRegistry<V>(
  opts: CreateOwnedRegistryOptions<V> = {},
): OwnedRegistry<V> {
  // `clientId → tabId → V`. Two-level map so `forgetClient` is O(1) lookup
  // and `forgetTab` walks one shallow dimension.
  const byClient = new Map<string, Map<number, V>>();
  const unsubscribers: Array<() => void> = [];

  function evict(clientId: string, tabId: number, value: V): void {
    if (!opts.onEvict) return;
    try {
      opts.onEvict({ clientId, tabId, value });
    } catch {
      // teardown errors are non-fatal; the next eviction must still run
    }
  }

  function deleteEntry(clientId: string, tabId: number): boolean {
    const inner = byClient.get(clientId);
    if (!inner) return false;
    const value = inner.get(tabId);
    if (!inner.delete(tabId)) return false;
    if (inner.size === 0) byClient.delete(clientId);
    if (value !== undefined) evict(clientId, tabId, value);
    return true;
  }

  const registry: OwnedRegistry<V> = {
    get(clientId, tabId) {
      return byClient.get(resolveClientId(clientId))?.get(tabId);
    },
    set(clientId, tabId, value) {
      const key = resolveClientId(clientId);
      let inner = byClient.get(key);
      if (!inner) {
        inner = new Map<number, V>();
        byClient.set(key, inner);
      }
      inner.set(tabId, value);
    },
    delete(clientId, tabId) {
      return deleteEntry(resolveClientId(clientId), tabId);
    },
    has(clientId, tabId) {
      return byClient.get(resolveClientId(clientId))?.has(tabId) === true;
    },
    *entries() {
      for (const [clientId, inner] of byClient) {
        for (const [tabId, value] of inner) {
          yield { clientId, tabId, value };
        }
      }
    },
    size() {
      let total = 0;
      for (const inner of byClient.values()) total += inner.size;
      return total;
    },
    forgetTab(tabId) {
      const evicted: OwnedRegistryEntry<V>[] = [];
      for (const [clientId, inner] of byClient) {
        const value = inner.get(tabId);
        if (value === undefined) continue;
        inner.delete(tabId);
        if (inner.size === 0) byClient.delete(clientId);
        evict(clientId, tabId, value);
        evicted.push({ clientId, tabId, value });
      }
      return evicted;
    },
    forgetClient(clientId) {
      const key = resolveClientId(clientId);
      const inner = byClient.get(key);
      if (!inner) return [];
      const evicted: OwnedRegistryEntry<V>[] = [];
      for (const [tabId, value] of inner) {
        evicted.push({ clientId: key, tabId, value });
      }
      byClient.delete(key);
      for (const entry of evicted) evict(entry.clientId, entry.tabId, entry.value);
      return evicted;
    },
    dispose() {
      for (const off of unsubscribers) {
        try {
          off();
        } catch {
          /* best effort */
        }
      }
      unsubscribers.length = 0;
      byClient.clear();
    },
  };

  if (!opts.skipAutoSubscribe) {
    try {
      const onRemoved = (closedTabId: number) => {
        registry.forgetTab(closedTabId);
      };
      chrome.tabs?.onRemoved?.addListener(onRemoved);
      unsubscribers.push(() => {
        try {
          chrome.tabs?.onRemoved?.removeListener(onRemoved);
        } catch {
          /* best effort */
        }
      });
    } catch {
      // non-extension test context — eviction listener is best-effort
    }
    unsubscribers.push(
      subscribeOnClientReleased((releasedClientId) => {
        registry.forgetClient(releasedClientId);
      }),
    );
  }

  return registry;
}

/** Visible to debug-dump consumers that want to surface the system bucket. */
export const OWNED_REGISTRY_SYSTEM_CLIENT = SYSTEM_CLIENT;
