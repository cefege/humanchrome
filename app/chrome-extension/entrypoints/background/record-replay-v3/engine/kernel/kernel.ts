import type { JsonObject } from '../../domain/json';
import type { FlowId, NodeId, RunId } from '../../domain/ids';
import type { RRError } from '../../domain/errors';
import type { FlowV3 } from '../../domain/flow';
import type { DebuggerCommand, DebuggerState } from '../../domain/debug';
import type { RunEvent, RunStatus, Unsubscribe } from '../../domain/events';

export interface RunStartRequest {
  /** Caller-generated. */
  runId: RunId;
  flowId: FlowId;
  /** Snapshot of the Flow definition used for execution. */
  flowSnapshot: FlowV3;
  args?: JsonObject;
  /** Defaults to `flowSnapshot.entryNodeId`. */
  startNodeId?: NodeId;
  /** Caller must allocate the tab; each Run owns it exclusively. */
  tabId: number;
  debug?: { breakpoints?: NodeId[]; pauseOnStart?: boolean };
}

export interface RunResult {
  runId: RunId;
  status: Extract<RunStatus, 'succeeded' | 'failed' | 'canceled'>;
  tookMs: number;
  error?: RRError;
  outputs?: JsonObject;
}

export interface RunStatusInfo {
  status: RunStatus;
  currentNodeId?: NodeId;
  startedAt?: number;
  updatedAt: number;
  tabId?: number;
}

export interface ExecutionKernel {
  onEvent(listener: (event: RunEvent) => void): Unsubscribe;

  startRun(req: RunStartRequest): Promise<void>;

  pauseRun(runId: RunId, reason?: { kind: 'command' }): Promise<void>;

  resumeRun(runId: RunId): Promise<void>;

  cancelRun(runId: RunId, reason?: string): Promise<void>;

  debug(
    runId: RunId,
    cmd: DebuggerCommand,
  ): Promise<{ ok: true; state?: DebuggerState } | { ok: false; error: string }>;

  /** Returns null when the Run does not exist. */
  getRunStatus(runId: RunId): Promise<RunStatusInfo | null>;

  /** Called after Service Worker restart to resume interrupted Runs. */
  recover(): Promise<void>;
}

export function createNotImplementedKernel(): ExecutionKernel {
  const notImplemented = () => {
    throw new Error('ExecutionKernel not implemented');
  };

  return {
    onEvent: () => {
      notImplemented();
      return () => {};
    },
    startRun: async () => notImplemented(),
    pauseRun: async () => notImplemented(),
    resumeRun: async () => notImplemented(),
    cancelRun: async () => notImplemented(),
    debug: async () => notImplemented(),
    getRunStatus: async () => notImplemented(),
    recover: async () => notImplemented(),
  };
}
