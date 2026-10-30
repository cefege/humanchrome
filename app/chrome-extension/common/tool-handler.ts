import type { CallToolResult, TextContent, ImageContent } from '@modelcontextprotocol/server';
import { ToolErrorCode, browserMetadataPolicy, isToolError, serializeToolError } from 'humanchrome-shared';

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
 * raw text still see the message; programmatic callers can JSON.parse. This path deliberately
 * does not touch the Rust kernel, so a kernel-initialization failure can be surfaced once.
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
 * Rust owns the plain-message category and any no-tab message normalization after the
 * dispatcher has awaited kernel readiness. JavaScript retains opaque `ToolError` identity,
 * original thrown-value extraction, detail merging, and error-envelope serialization.
 *
 * Resolution priority:
 *   1. ToolError instance → preserve its code + details (merged with
 *      ctx, ctx winning on key conflict so tools can override e.g.
 *      `details.frameId`).
 *   2. Rust classifies the plain host message as TAB_CLOSED or UNKNOWN and returns the
 *      already-normalized message.
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
  const plan = browserMetadataPolicy.classifyTabErrorMessage(msg, tabId);
  const code = plan.code === 'TAB_CLOSED' ? ToolErrorCode.TAB_CLOSED : ToolErrorCode.UNKNOWN;
  return createErrorResponse(plan.message, code, ctxDetails);
};
