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
