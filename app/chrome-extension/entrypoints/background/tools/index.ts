import { createErrorResponse, createErrorResponseFromThrown } from '@/common/tool-handler';
import { ToolErrorCode } from 'humanchrome-shared';
import * as browserTools from './browser';
import { flowRunTool, listPublishedFlowsTool } from './record-replay';
import { debugLog } from '../utils/debug-log';
import { recordClientTab, resolveTabIdForClient } from '../utils/client-state';
import { acquireTabLock } from '../utils/tab-lock';

const tools = { ...browserTools, flowRunTool, listPublishedFlowsTool } as any;
const toolsMap = new Map(Object.values(tools).map((tool: any) => [tool.name, tool]));

export interface ToolCallParam {
  name: string;
  args: any;
}

/**
 * Resolve target tab for this call: caller's explicit tabId beats this
 * client's preferred tab (last successful call). When neither is set the
 * tool falls back to the active tab via its own getActiveTabOrThrow path.
 */
function resolveTargetTabId(args: any, clientId: string | undefined): number | undefined {
  const explicit = typeof args?.tabId === 'number' ? (args.tabId as number) : undefined;
  if (explicit !== undefined) return explicit;
  return resolveTabIdForClient(clientId);
}

/**
 * Sniff a numeric `tabId` out of a tool's response payload. Tool responses
 * serialize their JSON inside a single text content block; navigate-like
 * tools include a `tabId` field for the tab they ended up using. Used to
 * record the client's preferred-tab pointer when the caller didn't pin one.
 */
function extractTabIdFromResult(result: any): number | undefined {
  const block = result?.content?.find?.((c: any) => c?.type === 'text');
  if (!block?.text || typeof block.text !== 'string') return undefined;
  try {
    const parsed = JSON.parse(block.text);
    const id = parsed?.tabId ?? parsed?.tab?.id;
    return typeof id === 'number' ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Handle tool execution.
 *
 * @param param      Tool name and args from the MCP caller.
 * @param requestId  Optional correlation id from the native-messaging envelope.
 * @param clientId   Optional MCP-session id. When set, callers without an
 *   explicit `tabId` get this client's last-used tab — eliminating cross-talk
 *   between concurrent MCP clients.
 */
export const handleCallTool = async (
  param: ToolCallParam,
  requestId?: string,
  clientId?: string,
) => {
  const tabId = resolveTargetTabId(param.args, clientId);
  // Surface the resolved tab into args so the tool sees a tabId even when the
  // caller omitted one. Tool internals stay unchanged.
  if (
    tabId !== undefined &&
    param.args &&
    typeof param.args === 'object' &&
    param.args.tabId !== tabId
  ) {
    param = { ...param, args: { ...param.args, tabId } };
  }
  const startedAt = Date.now();
  debugLog.info('tool call start', {
    requestId,
    tool: param.name,
    tabId,
    data: { clientId: clientId ?? '<no-client>' },
  });

  const tool = toolsMap.get(param.name);
  if (!tool) {
    debugLog.warn('tool not found', { requestId, tool: param.name });
    return createErrorResponse(`Tool ${param.name} not found`, ToolErrorCode.INVALID_ARGS, {
      tool: param.name,
    });
  }

  const run = async () => {
    try {
      const result = await tool.execute(param.args);
      const ok = !(result && (result as any).isError === true);
      if (ok) {
        // Tools like chrome_navigate pick a tab themselves when the caller
        // omits one — read the tab back out of the response so the client's
        // preferred-tab pointer follows the tab the tool actually used.
        // Skip the sniff when the caller already pinned a tab; tool responses
        // can be tens of KB (read-page) and JSON-parsing them per call adds
        // up on hot paths.
        const sniffed = tabId === undefined ? extractTabIdFromResult(result) : undefined;
        const effectiveTabId = tabId ?? sniffed;
        if (typeof effectiveTabId === 'number') {
          recordClientTab(clientId, effectiveTabId);
        }
        debugLog.debug('client tab recorded', {
          requestId,
          tool: param.name,
          tabId: effectiveTabId,
          data: {
            inputTabId: tabId ?? null,
            sniffed: sniffed ?? null,
            clientId: clientId ?? '<no-client>',
          },
        });
      }
      debugLog.info('tool call done', {
        requestId,
        tool: param.name,
        tabId,
        data: { ok, durationMs: Date.now() - startedAt },
      });
      return result;
    } catch (error) {
      console.error(`Tool execution failed for ${param.name}:`, error);
      debugLog.error('tool call threw', {
        requestId,
        tool: param.name,
        tabId,
        data: {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return createErrorResponseFromThrown(error);
    }
  };

  // Mutating tools serialize per-tab; reads and implicit-tab calls pass through.
  const mutates = (tool.constructor as { mutates?: boolean })?.mutates === true;
  if (!mutates || typeof tabId !== 'number') return run();

  let release: (() => void) | undefined;
  try {
    release = await acquireTabLock(tabId);
  } catch (err) {
    debugLog.warn('tab lock timeout', { requestId, tool: param.name, tabId });
    return createErrorResponseFromThrown(err);
  }
  try {
    return await run();
  } finally {
    release();
  }
};
