/**
 * Shared run-enqueue service used by both the RPC server and the
 * TriggerManager so the two paths cannot drift in validation, record
 * creation, queue insertion, or event emission.
 */

import type { JsonObject, UnixMillis } from '../../domain/json';
import type { FlowId, NodeId, RunId } from '../../domain/ids';
import type { TriggerFireContext } from '../../domain/triggers';
import { RUN_SCHEMA_VERSION, type RunRecordV3 } from '../../domain/events';
import type { StoragePort } from '../storage/storage-port';
import type { EventsBus } from '../transport/events-bus';
import type { RunScheduler } from './scheduler';

export interface EnqueueRunDeps {
  storage: Pick<StoragePort, 'flows' | 'runs' | 'queue'>;
  events: Pick<EventsBus, 'append'>;
  scheduler?: Pick<RunScheduler, 'kick'>;
  /** Test-injection seam for run-id generation. */
  generateRunId?: () => RunId;
  /** Test-injection seam for the time source. */
  now?: () => UnixMillis;
}

export interface EnqueueRunInput {
  flowId: FlowId;
  /** Defaults to the Flow's entryNodeId. */
  startNodeId?: NodeId;
  /** Defaults to 0. */
  priority?: number;
  /** Defaults to 1. */
  maxAttempts?: number;
  args?: JsonObject;
  /** Set by TriggerManager when the run originates from a trigger. */
  trigger?: TriggerFireContext;
  debug?: {
    breakpoints?: NodeId[];
    pauseOnStart?: boolean;
  };
}

export interface EnqueueRunResult {
  runId: RunId;
  /** 1-based position in the queue. */
  position: number;
}

function defaultGenerateRunId(): RunId {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function validateInt(
  value: unknown,
  defaultValue: number,
  fieldName: string,
  opts?: { min?: number; max?: number },
): number {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  const intValue = Math.floor(value);
  if (opts?.min !== undefined && intValue < opts.min) {
    throw new Error(`${fieldName} must be >= ${opts.min}`);
  }
  if (opts?.max !== undefined && intValue > opts.max) {
    throw new Error(`${fieldName} must be <= ${opts.max}`);
  }
  return intValue;
}

/**
 * Compute the Run's position in the queue, ordered by priority DESC then
 * createdAt ASC. Returns 1-based position, or -1 when the run is no longer
 * queued (the scheduler may have already claimed it). Callers should handle
 * -1 gracefully.
 */
async function computeQueuePosition(
  storage: Pick<StoragePort, 'queue'>,
  runId: RunId,
): Promise<number> {
  const queueItems = await storage.queue.list('queued');
  queueItems.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.createdAt - b.createdAt;
  });
  const index = queueItems.findIndex((item) => item.id === runId);
  // Return -1 if not found (run may have been claimed already)
  return index === -1 ? -1 : index + 1;
}

export async function enqueueRun(
  deps: EnqueueRunDeps,
  input: EnqueueRunInput,
): Promise<EnqueueRunResult> {
  const { flowId } = input;
  if (!flowId) {
    throw new Error('flowId is required');
  }

  const now = deps.now ?? (() => Date.now());
  const generateRunId = deps.generateRunId ?? defaultGenerateRunId;

  const priority = validateInt(input.priority, 0, 'priority');
  const maxAttempts = validateInt(input.maxAttempts, 1, 'maxAttempts', { min: 1 });

  const flow = await deps.storage.flows.get(flowId);
  if (!flow) {
    throw new Error(`Flow "${flowId}" not found`);
  }

  if (input.startNodeId) {
    const nodeExists = flow.nodes.some((n) => n.id === input.startNodeId);
    if (!nodeExists) {
      throw new Error(`startNodeId "${input.startNodeId}" not found in flow "${flowId}"`);
    }
  }

  const ts = now();
  const runId = generateRunId();

  const runRecord: RunRecordV3 = {
    schemaVersion: RUN_SCHEMA_VERSION,
    id: runId,
    flowId,
    status: 'queued',
    createdAt: ts,
    updatedAt: ts,
    attempt: 0,
    maxAttempts,
    args: input.args,
    trigger: input.trigger,
    debug: input.debug,
    startNodeId: input.startNodeId,
    nextSeq: 0,
  };
  await deps.storage.runs.save(runRecord);

  await deps.storage.queue.enqueue({
    id: runId,
    flowId,
    priority,
    maxAttempts,
    args: input.args,
    trigger: input.trigger,
    debug: input.debug,
  });

  await deps.events.append({
    runId,
    type: 'run.queued',
    flowId,
  });

  // Compute position before kick() to reduce the chance the scheduler claims
  // the run first and we end up returning -1.
  const position = await computeQueuePosition(deps.storage, runId);

  if (deps.scheduler) {
    void deps.scheduler.kick();
  }

  return { runId, position };
}
