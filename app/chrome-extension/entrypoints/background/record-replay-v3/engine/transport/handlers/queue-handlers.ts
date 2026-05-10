/**
 * Queue management handlers extracted from rpc-server.ts (IMP-0052 slice 1).
 *
 * Free functions over a deps bag so the orchestrator (RpcServer) stays
 * focused on port lifecycle + dispatch.
 */
import type { JsonObject, JsonValue } from '../../../domain/json';
import type { FlowId, NodeId, RunId } from '../../../domain/ids';
import type { StoragePort } from '../../storage/storage-port';
import type { EventsBus } from '../events-bus';
import type { RunScheduler } from '../../queue/scheduler';
import { compareQueueItems, isQueueItemStatus, QUEUE_ITEM_STATUSES } from '../../queue/queue';
import { enqueueRun } from '../../queue/enqueue-run';

export interface QueueHandlerDeps {
  storage: StoragePort;
  events: EventsBus;
  scheduler?: RunScheduler;
  generateRunId: () => RunId;
  now: () => number;
}

export async function handleEnqueueRun(
  deps: QueueHandlerDeps,
  params: JsonObject | undefined,
): Promise<JsonValue> {
  const result = await enqueueRun(deps, {
    flowId: params?.flowId as FlowId,
    startNodeId: params?.startNodeId as NodeId | undefined,
    priority: params?.priority as number | undefined,
    maxAttempts: params?.maxAttempts as number | undefined,
    args: params?.args as JsonObject | undefined,
    debug: params?.debug as { breakpoints?: string[]; pauseOnStart?: boolean } | undefined,
  });

  return result as unknown as JsonValue;
}

/** Lists queue items ordered by priority DESC then createdAt ASC (FIFO within priority). */
export async function handleListQueue(
  deps: QueueHandlerDeps,
  params: JsonObject | undefined,
): Promise<JsonValue> {
  const rawStatus = params?.status;
  if (rawStatus !== undefined && !isQueueItemStatus(rawStatus)) {
    throw new Error(`status must be one of: ${QUEUE_ITEM_STATUSES.join(', ')}`);
  }

  const items = await deps.storage.queue.list(rawStatus);
  items.sort(compareQueueItems);
  return items as unknown as JsonValue;
}

/**
 * Cancel a queue item. Only `status=queued` may be cancelled here;
 * running/paused runs must use rr_v3.cancelRun.
 */
export async function handleCancelQueueItem(
  deps: QueueHandlerDeps,
  params: JsonObject | undefined,
): Promise<JsonValue> {
  const runId = params?.runId as RunId | undefined;
  if (!runId) throw new Error('runId is required');

  const reason = params?.reason as string | undefined;
  const now = deps.now();

  const queueItem = await deps.storage.queue.get(runId);
  if (!queueItem) {
    throw new Error(`Queue item "${runId}" not found`);
  }

  if (queueItem.status !== 'queued') {
    throw new Error(
      `Cannot cancel queue item "${runId}" with status "${queueItem.status}"; use rr_v3.cancelRun for running/paused runs`,
    );
  }

  // Queue + run writes touch independent stores, so parallelize. Emit afterwards
  // so subscribers don't observe `run.canceled` before the row reflects it.
  await Promise.all([
    deps.storage.queue.cancel(runId, now, reason),
    deps.storage.runs.patch(runId, {
      status: 'canceled',
      updatedAt: now,
      finishedAt: now,
    }),
  ]);
  await deps.events.append({
    runId,
    type: 'run.canceled',
    reason,
  });

  return { ok: true, runId };
}
