/**
 * Structured error codes for tool responses.
 *
 * LLM-callable tools return errors as plain text in MCP `text` content blocks.
 * Wrapping that text in a JSON envelope `{ "error": { "code", "message", "details" } }`
 * lets callers branch on failure type (retry on CDP_BUSY, re-read page on
 * TARGET_NAVIGATED_AWAY, etc.) instead of regex-matching free-form strings.
 */
export enum ToolErrorCode {
  /** Tool was given a tabId that doesn't exist (or never did). */
  TAB_NOT_FOUND = 'TAB_NOT_FOUND',
  /** The tab existed at start of call but was closed during execution. */
  TAB_CLOSED = 'TAB_CLOSED',
  /** The tab navigated to a different URL/document while the tool was running. */
  TARGET_NAVIGATED_AWAY = 'TARGET_NAVIGATED_AWAY',
  /** Content-script ping/pong didn't return in time. */
  INJECTION_TIMEOUT = 'INJECTION_TIMEOUT',
  /** chrome.scripting.executeScript rejected (CSP, restricted page, etc.). */
  INJECTION_FAILED = 'INJECTION_FAILED',
  /** A CDP-using tool conflicted with another debugger client (often DevTools open). */
  CDP_BUSY = 'CDP_BUSY',
  /** CDP session detached unexpectedly mid-call. */
  CDP_DETACHED = 'CDP_DETACHED',
  /** Per-tab serialization lock could not be acquired before timeout. */
  TAB_LOCK_TIMEOUT = 'TAB_LOCK_TIMEOUT',
  /** Caller targeted a tab already owned by another MCP client. */
  TAB_NOT_OWNED = 'TAB_NOT_OWNED',
  /** Generic timeout (network request, page-load wait, etc.). */
  TIMEOUT = 'TIMEOUT',
  /** Caller passed invalid or missing arguments. */
  INVALID_ARGS = 'INVALID_ARGS',
  /** Chrome (or the user) refused the operation. */
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  /** Catch-all for unclassified failures. */
  UNKNOWN = 'UNKNOWN',
}

export interface ToolErrorEnvelope {
  error: {
    code: ToolErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Tagged error class. Throw from tool internals; the outer error responder
 * unpacks `code`/`details` into the structured envelope.
 *
 * Plain `Error` instances are still accepted and mapped to UNKNOWN, so old
 * call sites keep working unchanged.
 */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}

export function isToolError(err: unknown): err is ToolError {
  return err instanceof Error && (err as ToolError).code !== undefined && err.name === 'ToolError';
}

/**
 * Serialize a structured error into the JSON-encoded text MCP clients receive.
 * Kept stable so downstream parsers can rely on the shape.
 */
export function serializeToolError(
  code: ToolErrorCode,
  message: string,
  details?: Record<string, unknown>,
): string {
  const envelope: ToolErrorEnvelope = {
    error: { code, message, ...(details ? { details } : {}) },
  };
  return JSON.stringify(envelope);
}
