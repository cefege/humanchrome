import type {
  RustRunBreakpoints as WasmRustRunBreakpoints,
  RustTriggerAdmission as WasmRustTriggerAdmission,
} from '../generated/humanchrome_wasm';
import { getRustKernel } from './rust-bindings';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface QueueOrderItem {
  priority: number;
  createdAt: number;
}

export interface NormalizedEnqueueNumbers {
  priority: number;
  maxAttempts: number;
}

export type RecoveryAction = 'clean' | 'requeue' | 'adoptPaused' | 'keep';

export type RunErrorPlan =
  | { kind: 'stop' }
  | { kind: 'continue' }
  | { kind: 'goto'; target: { kind: 'edgeLabel'; label: string } | { kind: 'node'; nodeId: string } }
  | { kind: 'retry'; hasOverride: boolean };

export interface RustBreakpoint {
  nodeId: string;
  enabled: boolean;
}

function encode(value: unknown): string {
  return JSON.stringify(value);
}

interface NodePolicyMergePlan {
  timeout: 'flow' | 'node';
  retry: 'flow' | 'node';
  onError: 'flow' | 'node';
  mergeArtifacts: boolean;
}

function decode<T>(value: string): T {
  return JSON.parse(value) as T;
}

/** Normalizes the numeric queue arguments without reading clocks or browser state. */
export function normalizeRunEnqueueNumbers(
  priority: unknown,
  maxAttempts: unknown,
): NormalizedEnqueueNumbers {
  return decode<NormalizedEnqueueNumbers>(
    getRustKernel().run_policy_normalize_enqueue(priority, maxAttempts),
  );
}

/** Sorts a queue batch once in Rust and returns the original objects in stable V3 order. */
export function sortRunQueueItems<T extends QueueOrderItem>(items: readonly T[]): T[] {
  const indexes = decode<number[]>(getRustKernel().run_policy_queue_sort_indexes(items));
  return indexes.map((index) => items[index]!);
}

/** Preserves the public comparator API for consumers that already use Array.sort directly. */
export function compareRunQueueItems(left: QueueOrderItem, right: QueueOrderItem): number {
  return getRustKernel().run_policy_compare_queue_items(
    left.priority,
    left.createdAt,
    right.priority,
    right.createdAt,
  );
}

/** Returns whether the lease has passed its strict expiry boundary. */
export function isRunLeaseExpired(expiresAt: number, now: number): boolean {
  return getRustKernel().run_policy_is_lease_expired(expiresAt, now);
}

/** Derives a lease expiry from host-provided time and TTL values. */
export function runLeaseExpiresAt(now: number, ttlMs: number): number {
  return getRustKernel().run_policy_lease_expires_at(now, ttlMs);
}

/** Selects screenshot capture without calling Chrome or retaining image bytes. */
export function shouldCaptureRunScreenshot(policy: string, failed: boolean): boolean {
  return getRustKernel().run_policy_should_capture_screenshot(policy, failed);
}

/** Selects the pre-clean storage action for a missing, active, or terminal run record. */
export function runRecoveryPrecleanAction(status: string | undefined): RecoveryAction {
  return getRustKernel().run_policy_recovery_preclean(status) as RecoveryAction;
}

/** Selects reconciliation after the queue host has recovered an orphaned lease. */
export function runRecoveryReconcileAction(
  recoveredStatus: 'running' | 'paused',
  runStatus: string | undefined,
): RecoveryAction {
  return getRustKernel().run_policy_recovery_reconcile(recoveredStatus, runStatus) as RecoveryAction;
}

/** Merges V3 runner policies through Rust while retaining JavaScript undefined and opaque values. */
export function mergeRunNodePolicy<T extends object>(
  flowDefault: T | undefined,
  nodePolicy: T | undefined,
): T {
  if (!flowDefault) return nodePolicy ?? ({} as T);
  if (!nodePolicy) return flowDefault;

  const flow = flowDefault as Record<string, unknown>;
  const node = nodePolicy as Record<string, unknown>;
  const plan = decode<NodePolicyMergePlan>(
    getRustKernel().run_policy_node_policy_merge_plan(flowDefault, nodePolicy),
  );
  return {
    timeout: plan.timeout === 'node' ? node.timeout : flow.timeout,
    retry: plan.retry === 'node' ? node.retry : flow.retry,
    onError: plan.onError === 'node' ? node.onError : flow.onError,
    artifacts: plan.mergeArtifacts
      ? { ...(flow.artifacts as object), ...(node.artifacts as object) }
      : flow.artifacts,
  } as T;
}

/** Selects an error-routing branch; retry scheduling and graph traversal remain their existing owners. */
export function planRunError(policy: JsonValue, hasOnErrorEdge: boolean): RunErrorPlan {
  return decode<RunErrorPlan>(getRustKernel().run_policy_error_plan(encode(policy), hasOnErrorEdge));
}

/** Owns synchronous breakpoint state after its realm's Rust kernel is ready. */
export class RustRunBreakpointState {
  readonly #wasm: WasmRustRunBreakpoints;

  constructor(initialBreakpoints?: readonly string[]) {
    this.#wasm = new (getRustKernel().RustRunBreakpoints)(
      initialBreakpoints === undefined ? undefined : encode(initialBreakpoints),
    );
  }

  add(nodeId: string): void {
    this.#wasm.add(encode(nodeId));
  }

  remove(nodeId: string): void {
    this.#wasm.remove(encode(nodeId));
  }

  setAll(nodeIds: readonly string[]): void {
    this.#wasm.set_all(encode(nodeIds));
  }

  enable(nodeId: string): void {
    this.#wasm.enable(encode(nodeId));
  }

  disable(nodeId: string): void {
    this.#wasm.disable(encode(nodeId));
  }

  hasBreakpoint(nodeId: string): boolean {
    return this.#wasm.has_breakpoint(encode(nodeId));
  }

  shouldPauseAt(nodeId: string): boolean {
    return this.#wasm.should_pause_at(encode(nodeId));
  }

  setStepMode(mode: 'none' | 'stepOver'): void {
    this.#wasm.set_step_over(mode === 'stepOver');
  }

  getStepMode(): 'none' | 'stepOver' {
    return this.#wasm.step_over() ? 'stepOver' : 'none';
  }

  getAll(): RustBreakpoint[] {
    return decode<RustBreakpoint[]>(this.#wasm.all());
  }

  getEnabled(): RustBreakpoint[] {
    const enabled = decode<string[]>(this.#wasm.enabled());
    return enabled.map((nodeId) => ({ nodeId, enabled: true }));
  }

  clear(): void {
    this.#wasm.clear();
  }
}

export interface TriggerStormControl {
  cooldownMs?: unknown;
  maxQueued?: unknown;
}

export type TriggerAdmission =
  | { kind: 'admit'; ticket: number }
  | {
      kind: 'drop';
      reason: 'notStarted' | 'notInstalled' | 'maxQueued' | 'cooldown';
      message: string;
    };

/** Owns V3 trigger admission, cooldown stamps, queue-cap checks, and enqueue rollback. */
export class RustTriggerAdmissionState {
  readonly #wasm: WasmRustTriggerAdmission;

  constructor(storm?: TriggerStormControl) {
    this.#wasm = new (getRustKernel().RustTriggerAdmission)(
      storm?.cooldownMs,
      storm?.maxQueued,
    );
  }

  start(): void {
    this.#wasm.start();
  }

  stop(): void {
    this.#wasm.stop();
  }

  isStarted(): boolean {
    return this.#wasm.is_started();
  }

  hasQueueCap(): boolean {
    return this.#wasm.has_queue_cap();
  }

  clearInstalled(): void {
    this.#wasm.clear_installed();
  }

  install(triggerId: string): void {
    this.#wasm.install(encode(triggerId));
  }

  uninstall(triggerId: string): void {
    this.#wasm.uninstall(encode(triggerId));
  }

  installedIds(): string[] {
    return decode<string[]>(this.#wasm.installed_ids());
  }

  admit(triggerId: string, now: number, queuedCount: number): TriggerAdmission {
    return decode<TriggerAdmission>(this.#wasm.admit(encode(triggerId), now, queuedCount));
  }

  finish(ticket: number, succeeded: boolean): void {
    this.#wasm.finish(ticket, succeeded);
  }
}

/** Normalizes and validates cron through Rust after a narrow host String observation. */
export function normalizeRunCron(
  value: unknown,
  normalize: (value: unknown) => string,
): string {
  return getRustKernel().run_policy_normalize_cron(value, normalize);
}

/** Normalizes timezone absence/type/error policy through Rust using narrow host observations. */
export function normalizeRunCronTimezone(
  value: unknown,
  trim: (value: string) => string,
  isValid: (value: string) => boolean,
): string | undefined {
  return getRustKernel().run_policy_normalize_timezone(value, trim, isValid);
}

export interface CronClockParts {
  timestampMs?: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
}

/** Searches local Date observations for the next cron fire without owning a scheduler. */
export function nextRunCronLocal(
  cron: string,
  fromMs: number,
  observeCandidate: (fromMs: number, dayOffset: number, hour: number, minute: number) => CronClockParts,
): number {
  return getRustKernel().run_policy_cron_next_local(cron, fromMs, observeCandidate);
}

/** Searches Intl time-zone observations for the next cron fire without a time-zone database. */
export function nextRunCronZoned(
  cron: string,
  timezone: string,
  fromMs: number,
  observeParts: (utcMs: number, timezone: string) => CronClockParts,
): number {
  return getRustKernel().run_policy_cron_next_zoned(cron, timezone, fromMs, observeParts);
}

export interface DomTriggerPayloadInput {
  id: string;
  selector?: unknown;
  appear?: unknown;
  once?: unknown;
  debounceMs?: unknown;
}

export interface DomTriggerPayload {
  id: string;
  selector: string;
  appear: boolean;
  once: boolean;
  debounceMs: number;
}

/** Canonicalizes one complete DOM observer payload through Rust and host string/locale intrinsics. */
export function buildRunDomTriggerPayload(
  entries: readonly DomTriggerPayloadInput[],
  localeCompare: (left: string, right: string) => number,
  stringify: (value: unknown) => string,
  trim: (value: string) => string,
): DomTriggerPayload[] {
  return decode<DomTriggerPayload[]>(
    getRustKernel().run_policy_dom_trigger_payload(entries, localeCompare, stringify, trim),
  );
}
