import type { CallToolResult, TextContent, ImageContent } from '@modelcontextprotocol/sdk/types.js';
import { ToolErrorCode, isToolError, serializeToolError } from 'humanchrome-shared';

export interface ToolResult extends CallToolResult {
  content: (TextContent | ImageContent)[];
  isError: boolean;
}

export interface ToolExecutor {
  execute(args: any): Promise<ToolResult>;
}

/**
 * Build an error ToolResult with a structured envelope inside the text content.
 *
 * Backward-compatible: existing callers `createErrorResponse('some message')`
 * still work and get a `UNKNOWN` code. New callers can pass a code and details.
 *
 * The body is JSON: `{"error":{"code","message","details"?}}`. LLMs reading
 * raw text still see the message; programmatic callers can JSON.parse.
 */
export const createErrorResponse = (
  message: string = 'Unknown error, please try again',
  code: ToolErrorCode = ToolErrorCode.UNKNOWN,
  details?: Record<string, unknown>,
): ToolResult => {
  return {
    content: [
      {
        type: 'text',
        text: serializeToolError(code, message, details),
      },
    ],
    isError: true,
  };
};

/**
 * Map an arbitrary thrown value into a structured error response.
 * Preserves code+details for `ToolError` instances; falls back to UNKNOWN otherwise.
 */
export const createErrorResponseFromThrown = (err: unknown): ToolResult => {
  if (isToolError(err)) {
    return createErrorResponse(err.message, err.code, err.details);
  }
  const message = err instanceof Error ? err.message : String(err);
  return createErrorResponse(message, ToolErrorCode.UNKNOWN);
};

/**
 * Classify a thrown value from a tool's catch block — IMP-0132.
 *
 * Centralizes the 16+ duplicated `/no tab with id/i` → TAB_CLOSED
 * patterns scattered across `tools/browser/`. Adding a new related
 * regex (e.g. `Receiving end does not exist`, `Could not establish
 * connection`) used to require touching every tool; now it's a
 * single-file change here.
 *
 * Resolution priority:
 *   1. ToolError instance → preserve its code + details (merged with
 *      ctx, ctx winning on key conflict so tools can override e.g.
 *      `details.frameId`).
 *   2. `/no tab with id/i` → TAB_CLOSED. When `ctx.tabId` is provided
 *      the message is normalised to `Tab N not found`; otherwise the
 *      original message is preserved.
 *   3. `/receiving end does not exist|could not establish connection/i`
 *      → TAB_CLOSED (content script gone — usually means the tab
 *      navigated or closed mid-call).
 *   4. fallback → UNKNOWN with the original message + ctx as details.
 *
 * `ctx.toolName` is included in `details` so log scrapers can attribute
 * the failure without re-parsing the message.
 */
export const classifyTabError = (
  err: unknown,
  ctx: {
    toolName?: string;
    tabId?: number;
    extraDetails?: Record<string, unknown>;
  } = {},
): ToolResult => {
  const { toolName, tabId, extraDetails } = ctx;
  const ctxDetails: Record<string, unknown> = {};
  if (typeof tabId === 'number') ctxDetails.tabId = tabId;
  if (toolName) ctxDetails.toolName = toolName;
  if (extraDetails) Object.assign(ctxDetails, extraDetails);

  if (isToolError(err)) {
    const merged = { ...(err.details ?? {}), ...ctxDetails };
    return createErrorResponse(err.message, err.code, merged);
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/no tab with id/i.test(msg)) {
    const message = typeof tabId === 'number' ? `Tab ${tabId} not found` : msg;
    return createErrorResponse(message, ToolErrorCode.TAB_CLOSED, ctxDetails);
  }
  if (/receiving end does not exist|could not establish connection/i.test(msg)) {
    return createErrorResponse(msg, ToolErrorCode.TAB_CLOSED, ctxDetails);
  }
  return createErrorResponse(msg, ToolErrorCode.UNKNOWN, ctxDetails);
};
