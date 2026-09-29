/**
 * `chrome_tasks` tool handler.
 *
 * Front door to the durable background queue. Intercepted at the top of
 * `dispatchTool` (never round-trips to the extension). Actions:
 *   - submit: enqueue one task or a batch; optionally block up to `waitMs`
 *     for inline completion (returns the real result when uncontended).
 *   - status: fetch a single task row.
 *   - list:   list tasks filtered by status/lane.
 *   - cancel: cancel a still-queued task.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ToolErrorCode, serializeToolError, buildInvalidArgsDetails } from 'humanchrome-shared';
import type { TaskRow } from '../agent/db';
import { getTaskQueue, type EnqueueInput } from './task-queue';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function invalidArgs(message: string, details: Record<string, unknown>): CallToolResult {
  return {
    content: [
      { type: 'text', text: serializeToolError(ToolErrorCode.INVALID_ARGS, message, details) },
    ],
    isError: true,
  };
}

function safeParse(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toStatusView(row: TaskRow): Record<string, unknown> {
  return { ...row, args: safeParse(row.args), result: safeParse(row.result) };
}

function toEnqueueInput(raw: unknown, clientId?: string): EnqueueInput {
  const r = isRecord(raw) ? raw : {};
  return {
    // Empty string trips enqueue's `tool is required` validation, surfacing
    // a structured INVALID_ARGS rather than a silent skip.
    tool: str(r.tool) ?? '',
    args: r.args,
    clientId,
    lane: str(r.lane),
    priority: num(r.priority),
    notBefore: str(r.notBefore),
    maxAttempts: num(r.maxAttempts),
    idemKey: str(r.idemKey),
  };
}

export async function handleTasksTool(
  rawArgs: unknown,
  clientId?: string,
): Promise<CallToolResult> {
  const bag = isRecord(rawArgs) ? rawArgs : {};
  const action = bag.action;
  const queue = getTaskQueue();

  switch (action) {
    case 'submit': {
      if (Array.isArray(bag.tasks)) {
        try {
          const results = queue.enqueueBatch(bag.tasks.map((t) => toEnqueueInput(t, clientId)));
          return ok({ status: 'batched', taskIds: results.map((r) => r.taskId) });
        } catch (err) {
          return invalidArgs(
            err instanceof Error ? err.message : String(err),
            buildInvalidArgsDetails({ arg: 'tasks', received: bag.tasks }),
          );
        }
      }

      let taskId: string;
      let deduped: boolean;
      try {
        const res = queue.enqueue(toEnqueueInput(bag, clientId));
        taskId = res.taskId;
        deduped = res.deduped;
      } catch (err) {
        return invalidArgs(
          err instanceof Error ? err.message : String(err),
          buildInvalidArgsDetails({ arg: 'tool', received: bag.tool }),
        );
      }

      const w = num(bag.waitMs);
      const waitMs = w && w > 0 ? w : 0;
      if (waitMs === 0) return ok({ status: 'queued', taskId, deduped });

      const row = await queue.waitForTask(taskId, waitMs);
      if (!row) return ok({ status: 'queued', taskId, deduped });
      if (row.status === 'done') {
        return ok({ status: 'completed', taskId, result: safeParse(row.result) });
      }
      if (row.status === 'failed') return ok({ status: 'failed', taskId, error: row.error });
      if (row.status === 'cancelled') return ok({ status: 'cancelled', taskId });
      return ok({ status: row.status, taskId, deduped });
    }

    case 'status': {
      const row = queue.getTask(str(bag.taskId) ?? '');
      return row ? ok(toStatusView(row)) : ok({ found: false });
    }

    case 'list': {
      const rows = queue.listTasks({
        status: str(bag.status),
        lane: str(bag.lane),
        limit: num(bag.limit),
      });
      return ok({ tasks: rows.map(toStatusView) });
    }

    case 'cancel': {
      const taskId = str(bag.taskId);
      if (!taskId) {
        return invalidArgs(
          '`taskId` is required (string) for cancel.',
          buildInvalidArgsDetails({ arg: 'taskId', received: bag.taskId }),
        );
      }
      return ok(queue.cancel(taskId));
    }

    default:
      return invalidArgs(
        `Unknown action: ${String(action)}. Expected one of submit|status|list|cancel.`,
        buildInvalidArgsDetails({
          arg: 'action',
          received: action,
          expected: { type: 'string', description: 'submit | status | list | cancel' },
        }),
      );
  }
}
