import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { inspectAllTabQueues, inspectTabQueue } from '../../utils/tab-queue';

interface QueueInspectParams {
  tabId?: number;
}

/**
 * Snapshot of per-tab queues (IMP-0087). Read-only diagnostic; no chrome.*
 * calls. Use when a caller reports slow tool dispatch or to verify the
 * queue drains correctly after closing a stuck tab.
 */
class QueueInspectTool extends BaseBrowserToolExecutor {
  name = 'chrome_diagnostics__queue_internal';
  static readonly autoSpawnTab = false;

  async execute(args: QueueInspectParams = {}): Promise<ToolResult> {
    if (args?.tabId !== undefined) {
      if (typeof args.tabId !== 'number' || !Number.isFinite(args.tabId)) {
        return createErrorResponse(
          '`tabId` must be a finite number when provided',
          ToolErrorCode.INVALID_ARGS,
          { arg: 'tabId' },
        );
      }
    }

    const tabs =
      args?.tabId !== undefined
        ? (() => {
            const snap = inspectTabQueue(args.tabId as number);
            return snap ? [snap] : [];
          })()
        : inspectAllTabQueues();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ tabs }),
        },
      ],
      isError: false,
    };
  }
}

export const queueInspectTool = new QueueInspectTool();
