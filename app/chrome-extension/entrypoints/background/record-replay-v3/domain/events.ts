import type { JsonObject, JsonValue, UnixMillis } from './json';
import type { EdgeLabel, FlowId, NodeId, RunId } from './ids';
import type { RRError } from './errors';
import type { TriggerFireContext } from './triggers';

export type Unsubscribe = () => void;

export type RunStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'canceled';

export interface EventBase {
  runId: RunId;
  ts: UnixMillis;
  /** Monotonically increasing sequence number. */
  seq: number;
}

export type PauseReason =
  | { kind: 'breakpoint'; nodeId: NodeId }
  | { kind: 'step'; nodeId: NodeId }
  | { kind: 'command' }
  | { kind: 'policy'; nodeId: NodeId; reason: string };

export type RecoveryReason = 'sw_restart' | 'lease_expired';

export type RunEvent =
  | (EventBase & { type: 'run.queued'; flowId: FlowId })
  | (EventBase & { type: 'run.started'; flowId: FlowId; tabId: number })
  | (EventBase & { type: 'run.paused'; reason: PauseReason; nodeId?: NodeId })
  | (EventBase & { type: 'run.resumed' })
  | (EventBase & {
      type: 'run.recovered';
      reason: RecoveryReason;
      fromStatus: 'running' | 'paused';
      toStatus: 'queued';
      /** Previous ownerId, kept for audit. */
      prevOwnerId?: string;
    })
  | (EventBase & { type: 'run.canceled'; reason?: string })
  | (EventBase & { type: 'run.succeeded'; tookMs: number; outputs?: JsonObject })
  | (EventBase & { type: 'run.failed'; error: RRError; nodeId?: NodeId })
  | (EventBase & { type: 'node.queued'; nodeId: NodeId })
  | (EventBase & { type: 'node.started'; nodeId: NodeId; attempt: number })
  | (EventBase & {
      type: 'node.succeeded';
      nodeId: NodeId;
      tookMs: number;
      next?: { kind: 'edgeLabel'; label: EdgeLabel } | { kind: 'end' };
    })
  | (EventBase & {
      type: 'node.failed';
      nodeId: NodeId;
      attempt: number;
      error: RRError;
      decision: 'retry' | 'continue' | 'stop' | 'goto';
    })
  | (EventBase & { type: 'node.skipped'; nodeId: NodeId; reason: 'disabled' | 'unreachable' })
  | (EventBase & {
      type: 'vars.patch';
      patch: Array<{ op: 'set' | 'delete'; name: string; value?: JsonValue }>;
    })
  | (EventBase & { type: 'artifact.screenshot'; nodeId: NodeId; data: string; savedAs?: string })
  | (EventBase & {
      type: 'log';
      level: 'debug' | 'info' | 'warn' | 'error';
      message: string;
      data?: JsonValue;
    });

export type RunEventType = RunEvent['type'];

/** Distributive Omit so the union is preserved. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * Event input type. seq must be assigned atomically by the storage layer
 * (via RunRecordV3.nextSeq); ts defaults to Date.now() when omitted.
 */
export type RunEventInput = DistributiveOmit<RunEvent, 'seq' | 'ts'> & {
  ts?: UnixMillis;
};

export const RUN_SCHEMA_VERSION = 3 as const;

export interface RunRecordV3 {
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  id: RunId;
  flowId: FlowId;

  status: RunStatus;
  createdAt: UnixMillis;
  updatedAt: UnixMillis;

  startedAt?: UnixMillis;
  finishedAt?: UnixMillis;
  tookMs?: number;

  /** Bound Tab ID — each Run owns its tab exclusively. */
  tabId?: number;
  /** Optional override entry node when not using the flow default. */
  startNodeId?: NodeId;
  currentNodeId?: NodeId;

  attempt: number;
  maxAttempts: number;

  args?: JsonObject;
  trigger?: TriggerFireContext;
  debug?: { breakpoints?: NodeId[]; pauseOnStart?: boolean };

  error?: RRError;
  outputs?: JsonObject;

  /** Cached next event sequence number. */
  nextSeq: number;
}

export function isTerminalStatus(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

export function isActiveStatus(status: RunStatus): boolean {
  return status === 'running' || status === 'paused';
}
