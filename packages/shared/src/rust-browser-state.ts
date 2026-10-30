import { getRustKernel } from './rust-bindings';
import type { RustBrowserState as WasmRustBrowserState } from '../generated/humanchrome_wasm';

export type PacingProfile = 'off' | 'human' | 'careful' | 'fast';
export type TargetAccess = 'read' | 'mutate';
export type TabLiveness = 'unprobed' | 'live' | 'missing';
export interface PacingState { profile: PacingProfile; minGapMs: number; jitterMs: number; lastDispatchAt: number; }
export interface OwnershipEntry { ownedTabIds: number[]; activeTabId?: number; lastWindowId?: number; lastSeenAt: number; aliases?: Record<string, number>; }
export type OwnershipSnapshot = Record<string, OwnershipEntry>;
export interface RestoreReport { restoredClients: number; droppedTabIds: number; droppedClients: number; }
export interface ClientStateSnapshot extends OwnershipEntry { pacing?: PacingState; }
export interface BrowserPolicyError { code: 'TAB_NOT_OWNED' | 'TAB_NOT_FOUND' | 'INVALID_ARGS' | 'TAB_LOCK_TIMEOUT' | 'QUEUE_FULL' | 'TAB_CLOSED'; message: string; details: unknown; }
export interface TargetRequest { clientId?: string; explicitTabId?: number; trimmedTabAlias?: string; access?: TargetAccess; }
export interface DispatchRequest { target: TargetRequest; autoSpawnPolicy?: 'enabled' | 'disabled'; urlTargeting?: 'absent' | 'provided'; explicitWindowId?: number; windowTargeting?: 'useClientHint' | 'explicitOnly'; tabLiveness?: TabLiveness; }
export interface DispatchReady { resolvedTabId?: number; forwardedTabId?: number; forwardedWindowId?: number; autoSpawn?: { preferredWindowId?: number }; }
declare const dispatchContinuationBrand: unique symbol;
export interface DispatchContinuation { readonly id: number; readonly tabId: number; readonly [dispatchContinuationBrand]: void; }
export type DispatchPlan = { kind: 'rejected'; error: BrowserPolicyError } | { kind: 'needsLivenessProbe'; continuation: DispatchContinuation } | { kind: 'ready'; target: DispatchReady };
export interface QueueGrant { ticket: number; queuedAtPosition: number; waitedMs: number; }
export interface QueuedTicket { ticket: number; queuedAtPosition: number; deadlineAt: number; }
export interface QueueTransition { promoted: QueueGrant | null; cancelled: Array<{ ticket: number; error: BrowserPolicyError }>; retired: boolean; }
export interface QueueSnapshot { tabId: number; depth: number; servedTotal: number; meanHoldMs: number; holder: { clientId: string | null; heldMs: number; ticket: number } | null; waiters: Array<{ clientId: string | null; position: number; waitedMs: number; expectedWaitMs: number; ticket: number }>; }

/** Typed synchronous host wrapper for the WASM-owned browser policy state. */
export class RustBrowserState {
  readonly #wasm: WasmRustBrowserState;
  constructor() { this.#wasm = new (getRustKernel().RustBrowserState)(); }
  get persistenceDirty(): boolean { return this.#wasm.persistence_dirty(); }
  markPersisted(): void { this.#wasm.mark_persisted(); }
  ownershipSnapshot(): OwnershipSnapshot { return decode(this.#wasm.ownership_snapshot()); }
  restoreOwnership(snapshot: OwnershipSnapshot, aliveTabIds: readonly number[] | null, now: number): RestoreReport { return decode(this.#wasm.restore_ownership(json(snapshot), json(aliveTabIds), integer(now))); }
  clientSnapshot(clientId: string | undefined): ClientStateSnapshot | null { return decode(this.#wasm.client_snapshot(json(clientId))); }
  evictStaleClients(now: number): number { return this.#wasm.evict_stale_clients(integer(now)); }
  setPacing(clientId: string | undefined, profile: PacingProfile, overrides: { minGapMs?: number; jitterMs?: number } | undefined, now: number): PacingState | null { return decode(this.#wasm.set_pacing(json(clientId), json(profile), json(overrides), integer(now))); }
  pacing(clientId: string | undefined): PacingState | null { return decode(this.#wasm.pacing(json(clientId))); }
  consumePacingDelay(clientId: string | undefined, now: number, randomSample: number): number { return Number(this.#wasm.consume_pacing_delay(json(clientId), integer(now), randomSample)); }
  claimTab(clientId: string | undefined, tabId: number, windowId: number | undefined, now: number): string | null { return decode(this.#wasm.claim_tab(json(clientId), integer(tabId), json(windowId), integer(now))); }
  releaseTab(clientId: string | undefined, tabId: number): boolean { return this.#wasm.release_tab(json(clientId), integer(tabId)); }
  tabOwner(tabId: number): string | null { return decode(this.#wasm.tab_owner(integer(tabId))); }
  releaseClient(clientId: string | undefined, now: number): number { return this.#wasm.release_client(json(clientId), integer(now)); }
  resolveOwnedTab(clientId: string | undefined, explicitTabId: number | undefined, access: TargetAccess, now: number): { tabId?: number; error?: BrowserPolicyError } { return decode(this.#wasm.resolve_owned_tab(json(clientId), json(explicitTabId), json(access), integer(now))); }
  resolveAlias(clientId: string | undefined, alias: string): { tabId?: number; error?: { alias: string; reason: 'unknown-alias' | 'tab-closed' } } { return decode(this.#wasm.resolve_alias(json(clientId), json(alias))); }
  resolveTarget(request: TargetRequest, now: number): { tabId?: number; error?: BrowserPolicyError } { return decode(this.#wasm.resolve_target(json(request), integer(now))); }
  recordClientTab(clientId: string | undefined, tabId: number, windowId: number | undefined, now: number): void { this.#wasm.record_client_tab(json(clientId), integer(tabId), json(windowId), integer(now)); }
  recordClientWindow(clientId: string | undefined, windowId: number, now: number): void { this.#wasm.record_client_window(json(clientId), integer(windowId), integer(now)); }
  resolveOwnedWindow(clientId: string | undefined, explicitWindowId: number | undefined): number | null { return decode(this.#wasm.resolve_owned_window(json(clientId), json(explicitWindowId))); }
  clearLastWindow(clientId: string | undefined, windowId: number): boolean { return this.#wasm.clear_last_window(json(clientId), integer(windowId)); }
  isValidAlias(alias: string): boolean { return getRustKernel().RustBrowserState.is_valid_alias(json(alias)); }
  setAlias(clientId: string | undefined, alias: string, tabId: number, now: number): number | null { return decode(this.#wasm.set_alias(json(clientId), json(alias), integer(tabId), integer(now))); }
  aliases(clientId: string | undefined): Record<string, number> { return decode(this.#wasm.aliases(json(clientId))); }
  handleTabRemoved(tabId: number): boolean { return this.#wasm.handle_tab_removed(integer(tabId)); }
  handleWindowRemoved(windowId: number): boolean { return this.#wasm.handle_window_removed(integer(windowId)); }
  planDispatch(request: DispatchRequest, now: number): DispatchPlan { return this.#decodePlan(this.#wasm.plan_dispatch(json(request), integer(now))); }
  resumeDispatch(continuation: DispatchContinuation, liveness: Exclude<TabLiveness, 'unprobed'>): DispatchPlan { return this.#decodePlan(this.#wasm.resume_dispatch(continuation.id, json(liveness))); }
  clampTabLockTimeout(timeoutMs: number | undefined): number | null { return decode(getRustKernel().RustBrowserState.clamp_tab_lock_timeout(json(timeoutMs))); }
  defaultTabLockTimeout(): number { return Number(getRustKernel().RustBrowserState.default_tab_lock_timeout()); }
  admitTabLock(tabId: number, clientId: string | undefined, timeoutMs: number | undefined, now: number): { kind: 'granted'; grant: QueueGrant } | { kind: 'queued'; ticket: QueuedTicket } | { kind: 'rejected'; error: BrowserPolicyError } { return decode(this.#wasm.admit_tab_lock(integer(tabId), json(clientId), json(timeoutMs), integer(now))); }
  timeoutTabLock(tabId: number, ticket: number, now: number, timeoutMs: number): QueueTransition { return decode(this.#wasm.timeout_tab_lock(integer(tabId), BigInt(ticket), integer(now), integer(timeoutMs))); }
  releaseTabLock(tabId: number, ticket: number, now: number): QueueTransition { return decode(this.#wasm.release_tab_lock(integer(tabId), BigInt(ticket), integer(now))); }
  closeTabQueue(tabId: number): QueueTransition { return decode(this.#wasm.close_tab_queue(integer(tabId))); }
  inspectTabQueue(tabId: number, now: number): QueueSnapshot | null { return decode(this.#wasm.inspect_tab_queue(integer(tabId), integer(now))); }
  inspectAllTabQueues(now: number): QueueSnapshot[] { return decode(this.#wasm.inspect_all_tab_queues(integer(now))); }
  activeLockedTabCount(): number { return this.#wasm.active_locked_tab_count(); }
  _resetQueuesForTest(): void { this.#wasm._reset_queues_for_test(); }
  _setQueueMeanHoldForTest(tabId: number, meanHoldMs: number): void { this.#wasm._set_queue_mean_hold_for_test(integer(tabId), integer(meanHoldMs)); }
  _queueEntriesForTest(tabId: number): Array<{ ticket: number; clientId?: string; enqueuedAt: number; startedAt?: number }> { return decode(this.#wasm._queue_entries_for_test(integer(tabId))); }
  #decodePlan(raw: string): DispatchPlan { const plan = decode<{ kind: string; continuationId?: number; tabId?: number }>(raw); return plan.kind === 'needsLivenessProbe' ? { kind: 'needsLivenessProbe', continuation: { id: plan.continuationId!, tabId: plan.tabId! } as DispatchContinuation } : plan as DispatchPlan; }
}
function json(value: unknown): string { return JSON.stringify(value) ?? 'null'; }
function decode<T>(value: string): T { return JSON.parse(value) as T; }
function integer(value: number): bigint { if (!Number.isSafeInteger(value)) throw new TypeError('WASM integer arguments must be safe integers'); return BigInt(value); }
