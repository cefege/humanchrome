import { createErrorResponse, createErrorResponseFromThrown } from '@/common/tool-handler';
import { ToolErrorCode } from 'humanchrome-shared';
import * as browserTools from './browser';
import { flowRunTool, listPublishedFlowsTool } from './record-replay';
import { debugLog } from '../utils/debug-log';
import { recordClientTab, resolveTabIdForClient } from '../utils/client-state';
import { acquireTabLock } from '../utils/tab-lock';
import { runWithContext } from '../utils/request-context';

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
  // Bind a child logger so every line for this dispatch carries the same
  // correlation fields. The same `requestId` lands in the bridge's stderr
  // pino output via the native messaging envelope.
  const log = debugLog.with({ requestId, clientId, tool: param.name, tabId });
  log.info('tool call start');

  const tool = toolsMap.get(param.name);
  if (!tool) {
    log.warn('tool not found');
    return createErrorResponse(`Tool ${param.name} not found`, ToolErrorCode.INVALID_ARGS, {
      tool: param.name,
    });
  }

  const run = async () => {
    try {
      // Bind the active request context so BaseBrowserToolExecutor.sendMessageToTab
      // can tag outbound envelopes with the same correlation id we just logged.
      // The envelope shape is unchanged for callers that don't read the field.
      const result = await runWithContext<any>(
        { requestId, clientId, tool: param.name, tabId },
        () => tool.execute(param.args),
      );
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
        log.debug('client tab recorded', {
          tabId: effectiveTabId,
          data: { inputTabId: tabId ?? null, sniffed: sniffed ?? null },
        });
      }
      log.info('tool call done', {
        data: { ok, durationMs: Date.now() - startedAt },
      });
      return result;
    } catch (error) {
      log.error('tool call threw', {
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
    log.warn('tab lock timeout');
    return createErrorResponseFromThrown(err);
  }
  try {
    return await run();
  } finally {
    release();
  }
};
