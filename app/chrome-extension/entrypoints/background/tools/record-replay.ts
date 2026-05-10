import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { listPublished, getFlow, deleteFlow, unpublishFlow } from '../record-replay/flow-store';
import { runFlow } from '../record-replay/flow-runner';

class FlowRunTool {
  name = TOOL_NAMES.RECORD_REPLAY.FLOW_RUN;
  async execute(args: any): Promise<ToolResult> {
    const {
      flowId,
      args: vars,
      tabTarget,
      refresh,
      captureNetwork,
      returnLogs,
      timeoutMs,
      startUrl,
    } = args || {};
    if (!flowId) return createErrorResponse('flowId is required');
    const flow = await getFlow(flowId);
    if (!flow) return createErrorResponse(`Flow not found: ${flowId}`);
    const result = await runFlow(flow, {
      tabTarget,
      refresh,
      captureNetwork,
      returnLogs,
      timeoutMs,
      startUrl,
      args: vars,
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result),
        },
      ],
      isError: false,
    };
  }
}

class ListPublishedTool {
  name = TOOL_NAMES.RECORD_REPLAY.LIST_PUBLISHED;
  async execute(): Promise<ToolResult> {
    const list = await listPublished();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, published: list }),
        },
      ],
      isError: false,
    };
  }
}

/**
 * Delete a recorded flow. Closes the lifecycle gap left by
 * `record_replay_list_published` + `record_replay_flow_run` — without
 * a delete tool, agents accumulating versions during iterative
 * record-test-refine sessions had to open the extension UI to clean up.
 *
 * Always unpublishes first (idempotent — `unpublishFlow` no-ops on
 * unpublished flows) so the dynamic `flow.<slug>` MCP tool the bridge
 * exposes disappears even when the underlying flow record is being
 * deleted in the same call. The bridge cache is a TTL-bounded snapshot
 * (60s) so the next `tools/list` call picks up the change; flow callers
 * that pre-cached the slug get a `Flow not found` from `runFlow` and
 * can refresh.
 *
 * Returns `{deleted: true, unpublished: boolean, flowId}` on success.
 * `unpublished` reports whether the flow was published before deletion.
 */
class FlowDeleteTool {
  name = TOOL_NAMES.RECORD_REPLAY.FLOW_DELETE;
  static readonly mutates = true;

  async execute(args: { flowId?: string } = {}): Promise<ToolResult> {
    const flowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    if (!flowId) {
      return createErrorResponse('`flowId` (string) is required.', ToolErrorCode.INVALID_ARGS, {
        arg: 'flowId',
      });
    }
    const existing = await getFlow(flowId);
    if (!existing) {
      return createErrorResponse(`Flow not found: ${flowId}`, ToolErrorCode.INVALID_ARGS, {
        flowId,
      });
    }
    let wasPublished = false;
    try {
      const published = await listPublished();
      wasPublished = published.some((p) => p.id === flowId);
    } catch {
      // listPublished failures are not fatal — proceed with the delete.
    }
    try {
      await unpublishFlow(flowId);
    } catch (error) {
      // unpublishFlow on an unpublished flow may throw on some storage
      // backends. Don't fail the whole delete on that — the IndexedDB
      // delete below is the source of truth.
      console.warn('flow_delete: unpublishFlow threw, continuing with delete', error);
    }
    try {
      await deleteFlow(flowId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return createErrorResponse(
        `record_replay_flow_delete failed: ${msg}`,
        ToolErrorCode.UNKNOWN,
        {
          flowId,
        },
      );
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ deleted: true, unpublished: wasPublished, flowId }),
        },
      ],
      isError: false,
    };
  }
}

export const flowRunTool = new FlowRunTool();
export const listPublishedFlowsTool = new ListPublishedTool();
export const flowDeleteTool = new FlowDeleteTool();
