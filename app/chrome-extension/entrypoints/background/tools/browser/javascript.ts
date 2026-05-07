/**
 * JavaScript Tool - CDP Runtime.evaluate with fallback
 *
 * Execute JavaScript in the browser tab and return the result.
 * - Primary: CDP Runtime.evaluate (supports awaitPromise + returnByValue)
 * - Fallback: chrome.scripting.executeScript (when debugger is busy)
 *
 * Features:
 * - Async code support (top-level await via async wrapper)
 * - Output sanitization (sensitive data redaction)
 * - Output truncation (configurable max bytes)
 * - Timeout handling
 * - Detailed error classification
 */

import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { ToolErrorCode } from 'humanchrome-shared';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'humanchrome-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  sanitizeAndLimitOutput,
  sanitizeText,
} from '@/utils/output-sanitizer';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT_MS = 15_000;
const CDP_SESSION_KEY = 'javascript';

// ============================================================================
// Types
// ============================================================================

type ExecutionEngine = 'cdp' | 'scripting';

type ErrorKind =
  | 'debugger_conflict'
  | 'timeout'
  | 'syntax_error'
  | 'runtime_error'
  | 'cdp_error'
  | 'scripting_error';

interface JavaScriptToolParams {
  code: string;
  tabId?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface ExecutionError {
  kind: ErrorKind;
  message: string;
  details?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

interface ExecutionMetrics {
  elapsedMs: number;
}

interface JavaScriptToolResult {
  success: boolean;
  tabId: number;
  engine: ExecutionEngine;
  result?: string;
  truncated?: boolean;
  redacted?: boolean;
  warnings?: string[];
  error?: ExecutionError;
  metrics?: ExecutionMetrics;
}

interface ExecutionOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

// Discriminated union for execution results
type ExecutionSuccess = {
  ok: true;
  engine: ExecutionEngine;
  output: string;
  truncated: boolean;
  redacted: boolean;
};

type ExecutionFailure = {
  ok: false;
  engine: ExecutionEngine;
  error: ExecutionError;
};

type ExecutionResult = ExecutionSuccess | ExecutionFailure;

// ============================================================================
// Timeout Error
// ============================================================================

class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Execution timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);

    promise
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
}

function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof Error && error.name === 'TimeoutError';
}

function isDebuggerConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Debugger is already attached|Another debugger is already attached|Cannot attach to this target/i.test(
    message,
  );
}

/**
 * Decide whether `code` is a single trailing-expression form. If so we wrap it
 * with an explicit `return` so `chrome_javascript({code: '1+2'})` evaluates to
 * 3 instead of undefined. Statement blocks (anything containing `;`, a
 * `return`, `let`/`const`/`var` declarations, etc.) keep the legacy wrapping.
 *
 * Pure-heuristic — we cannot use `new Function` / `new AsyncFunction` as a
 * syntax probe in this code path because the extension service worker's CSP
 * disallows 'unsafe-eval'. The heuristic covers the common cases
 * (`location.href`, `document.title`, `1+2`, arrow-fn-call, `await fetch(...)`,
 * etc.). Borderline inputs that contain a top-level `;` / `{` keep the legacy
 * statement-block wrapping and require an explicit `return`.
 */
// \b boundary on keywords so `document.title` isn't mis-matched against `do`.
const STATEMENT_STARTERS =
  /^(let\b|const\b|var\b|return\b|if\b|for\b|while\b|do\b|switch\b|try\b|throw\b|function\b|class\b|async\s+function\b|\{)/;

function isExpressionForm(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) return false;
  // Balanced-paren shape (IIFE or parenthesized expression) is one expression
  // even if it contains `;` internally. Bare `(foo); bar();` won't match
  // because it ends in `;`, not `)`.
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) return true;
  if (trimmed.includes(';')) return false;
  if (STATEMENT_STARTERS.test(trimmed)) {
    return false;
  }
  // Otherwise treat as expression. Object literals inside expressions like
  // JSON.stringify({a:1}) are fine — only a *leading* `{` (caught above)
  // signals a block. await-prefixed expressions also pass through.
  return true;
}

/**
 * Wrap user code in an async IIFE to support top-level await and return statements.
 *
 * For single-expression input we inject an explicit `return` so trailing
 * expressions don't silently evaluate to undefined.
 */
function wrapUserCode(code: string): string {
  if (isExpressionForm(code)) {
    return `(async () => { return (${code.trim()}); })()`;
  }
  return `(async () => {\n${code}\n})()`;
}

// ============================================================================
// CDP Execution
// ============================================================================

interface CDPRemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

interface CDPExceptionDetails {
  text?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  exception?: {
    className?: string;
    description?: string;
    value?: string;
  };
}

interface CDPEvaluateResult {
  result?: CDPRemoteObject;
  exceptionDetails?: CDPExceptionDetails;
}

function extractReturnValue(remoteObject?: CDPRemoteObject): unknown {
  if (!remoteObject) return undefined;

  if ('value' in remoteObject) return remoteObject.value;
  if ('unserializableValue' in remoteObject) return remoteObject.unserializableValue;
  if (typeof remoteObject.description === 'string') return remoteObject.description;

  return undefined;
}

function parseExceptionDetails(details: CDPExceptionDetails): ExecutionError {
  const exceptionClassName = details.exception?.className ?? '';
  const exceptionDescription = details.exception?.description ?? '';
  const exceptionValue = details.exception?.value ?? '';
  const text = details.text ?? '';

  // Determine the raw error message
  const rawMessage =
    exceptionDescription || exceptionValue || text || 'JavaScript execution failed';

  // Sanitize the message
  const message = sanitizeText(rawMessage).text;

  // Classify the error kind
  const isSyntaxError = exceptionClassName === 'SyntaxError' || /SyntaxError/i.test(rawMessage);

  return {
    kind: isSyntaxError ? 'syntax_error' : 'runtime_error',
    message,
    details: {
      url: details.url,
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
    },
  };
}

async function executeViaCdp(
  tabId: number,
  code: string,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  try {
    const expression = wrapUserCode(code);

    const response = await withTimeout(
      cdpSessionManager.withSession(tabId, CDP_SESSION_KEY, async () => {
        return (await cdpSessionManager.sendCommand(
          tabId,
          'Runtime.evaluate',
          {
            expression,
            returnByValue: true,
            awaitPromise: true,
            // CDP-side timeout (ms); paired with outer withTimeout for belt-and-suspenders
            timeout: options.timeoutMs,
          },
          // Tell the session manager the same budget — its own default timeout
          // (10s) is too tight for user code with awaitPromise:true.
          options.timeoutMs + 1000,
        )) as CDPEvaluateResult;
      }),
      // Outer timeout adds slack so CDP has time to surface its own timeout response
      options.timeoutMs + 1000,
    );

    // Check for exception
    if (response?.exceptionDetails) {
      return {
        ok: false,
        engine: 'cdp',
        error: parseExceptionDetails(response.exceptionDetails),
      };
    }

    // Extract and sanitize the result
    const value = extractReturnValue(response?.result);
    const sanitized = sanitizeAndLimitOutput(value, { maxBytes: options.maxOutputBytes });

    return {
      ok: true,
      engine: 'cdp',
      output: sanitized.text,
      truncated: sanitized.truncated,
      redacted: sanitized.redacted,
    };
  } catch (error) {
    if (isTimeoutError(error)) {
      return {
        ok: false,
        engine: 'cdp',
        error: { kind: 'timeout', message: error.message },
      };
    }

    if (isDebuggerConflictError(error)) {
      const message = sanitizeText(error instanceof Error ? error.message : String(error)).text;
      return {
        ok: false,
        engine: 'cdp',
        error: { kind: 'debugger_conflict', message },
      };
    }

    const message = sanitizeText(error instanceof Error ? error.message : String(error)).text;
    return {
      ok: false,
      engine: 'cdp',
      error: { kind: 'cdp_error', message },
    };
  }
}

// ============================================================================
// chrome.scripting.executeScript Fallback
// ============================================================================

interface ScriptingExecutionResult {
  ok: boolean;
  value?: unknown;
  error?: {
    name?: string;
    message?: string;
    stack?: string;
  };
}

async function executeViaScripting(
  tabId: number,
  code: string,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  // Mirror the CDP path: bare expressions get an explicit `return` injected so
  // chrome_javascript({code: '1+2'}) evaluates to 3, not undefined.
  const userCode = isExpressionForm(code) ? `return (${code.trim()});` : code;

  const innerExecute = async (): Promise<ExecutionResult> => {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: async (injected: string): Promise<ScriptingExecutionResult> => {
        try {
          // Use AsyncFunction constructor to support top-level await

          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const fn = new AsyncFunction(injected);
          const value = await fn();
          return { ok: true, value };
        } catch (err: unknown) {
          const error = err as Error;
          return {
            ok: false,
            error: {
              name: error?.name ?? undefined,
              message: error?.message ?? String(err),
              stack: error?.stack ?? undefined,
            },
          };
        }
      },
      args: [userCode],
    });

    // Extract the first result
    const firstFrame = results?.[0];
    const result = (firstFrame as { result?: ScriptingExecutionResult })?.result;

    if (!result || typeof result !== 'object') {
      return {
        ok: false,
        engine: 'scripting',
        error: { kind: 'scripting_error', message: 'No result returned from executeScript' },
      };
    }

    if (!result.ok) {
      const rawMessage = result.error?.message ?? 'JavaScript execution failed';
      const rawStack = result.error?.stack;

      const message = sanitizeText(rawMessage).text;
      const sanitizedStack = rawStack ? sanitizeText(rawStack).text : undefined;

      const isSyntaxError = result.error?.name === 'SyntaxError' || /SyntaxError/i.test(rawMessage);

      return {
        ok: false,
        engine: 'scripting',
        error: {
          kind: isSyntaxError ? 'syntax_error' : 'runtime_error',
          message: sanitizedStack ? `${message}\n${sanitizedStack}` : message,
        },
      };
    }

    // Sanitize the successful result
    const sanitized = sanitizeAndLimitOutput(result.value, { maxBytes: options.maxOutputBytes });

    return {
      ok: true,
      engine: 'scripting',
      output: sanitized.text,
      truncated: sanitized.truncated,
      redacted: sanitized.redacted,
    };
  };

  try {
    return await withTimeout(innerExecute(), options.timeoutMs);
  } catch (error) {
    if (isTimeoutError(error)) {
      return {
        ok: false,
        engine: 'scripting',
        error: { kind: 'timeout', message: error.message },
      };
    }

    const message = sanitizeText(error instanceof Error ? error.message : String(error)).text;
    return {
      ok: false,
      engine: 'scripting',
      error: { kind: 'scripting_error', message },
    };
  }
}

// ============================================================================
// Tool Implementation
// ============================================================================

class JavaScriptTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.JAVASCRIPT;
  // JS execution can mutate page state via DOM/storage/etc.; treat as mutating.
  static readonly mutates = true;

  async execute(args: JavaScriptToolParams): Promise<ToolResult> {
    const startTime = performance.now();

    try {
      // Validate required parameter
      const code = typeof args?.code === 'string' ? args.code.trim() : '';
      if (!code) {
        return createErrorResponse('Parameter [code] is required', ToolErrorCode.INVALID_ARGS);
      }

      // Resolve target tab
      const tab = await this.resolveTargetTab(args.tabId);
      if (!tab) {
        const explicit = typeof args.tabId === 'number';
        return createErrorResponse(
          explicit ? `Tab not found: ${args.tabId}` : 'No active tab found',
          ToolErrorCode.TAB_NOT_FOUND,
          explicit ? { tabId: args.tabId } : undefined,
        );
      }

      if (!tab.id) {
        return createErrorResponse('Tab has no ID', ToolErrorCode.TAB_NOT_FOUND);
      }
      const tabId = tab.id;

      // Normalize options
      const options: ExecutionOptions = {
        timeoutMs: normalizePositiveInt(args.timeoutMs, DEFAULT_TIMEOUT_MS),
        maxOutputBytes: normalizePositiveInt(args.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
      };

      const warnings: string[] = [];

      // Try CDP execution first
      const cdpResult = await executeViaCdp(tabId, code, options);

      if (cdpResult.ok) {
        return this.buildSuccessResponse(tabId, cdpResult, startTime);
      }

      // If not a debugger conflict, return the CDP error.
      if (cdpResult.error.kind !== 'debugger_conflict') {
        // Tab-closed-mid-call surfaces as "Detached while handling command"
        // or "Target closed" from CDP. Classify these distinctly so callers
        // can branch on TAB_CLOSED / CDP_DETACHED instead of a free-form text.
        const cdpMsg = cdpResult.error.message ?? '';
        if (/detached|target closed/i.test(cdpMsg)) {
          // Verify the tab still exists. If it's gone, it's TAB_CLOSED;
          // otherwise the CDP session detached for some other reason.
          const stillThere = await this.tryGetTab(tabId);
          return createErrorResponse(
            cdpMsg,
            stillThere ? ToolErrorCode.CDP_DETACHED : ToolErrorCode.TAB_CLOSED,
            { tabId },
          );
        }
        const envelope = await this.maybeEnvelope(tabId, cdpResult);
        if (envelope) return envelope;
        return this.buildErrorResponse(tabId, cdpResult, startTime);
      }

      // Debugger conflict - fallback to scripting API
      warnings.push(
        'Debugger is busy (DevTools or another extension attached). Falling back to chrome.scripting.executeScript (runs in ISOLATED world, not page context).',
      );

      const scriptingResult = await executeViaScripting(tabId, code, options);

      if (scriptingResult.ok) {
        return this.buildSuccessResponse(tabId, scriptingResult, startTime, warnings);
      }

      const scriptingEnvelope = await this.maybeEnvelope(tabId, scriptingResult);
      if (scriptingEnvelope) return scriptingEnvelope;
      return this.buildErrorResponse(tabId, scriptingResult, startTime, warnings);
    } catch (error) {
      console.error('JavaScriptTool.execute error:', error);
      return createErrorResponse(
        `JavaScript tool error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async resolveTargetTab(tabId?: number): Promise<chrome.tabs.Tab | null> {
    if (typeof tabId === 'number') {
      return this.tryGetTab(tabId);
    }
    try {
      return await this.getActiveTabOrThrow();
    } catch {
      return null;
    }
  }

  /**
   * Classify a bridge-side execution failure into the structured-error
   * envelope. Returns null for failures that are genuinely user-code
   * errors (runtime exceptions in the script the caller wrote) — those
   * keep the JS-tool's richer payload via buildErrorResponse, since the
   * caller's debugging path is "look at error.message + stack," not
   * "branch on error code."
   */
  private async maybeEnvelope(tabId: number, result: ExecutionFailure): Promise<ToolResult | null> {
    const kind = result.error.kind;
    const message = result.error.message ?? '';
    switch (kind) {
      case 'scripting_error':
        // chrome.scripting.executeScript rejected — usually a restricted URL
        // (chrome://, devtools://) or extension-store page. Classify as
        // INJECTION_FAILED so the LLM knows the document refused script,
        // distinct from a runtime exception inside the user's code.
        return createErrorResponse(message, ToolErrorCode.INJECTION_FAILED, { tabId });
      case 'syntax_error':
        return createErrorResponse(message, ToolErrorCode.INVALID_ARGS, {
          tabId,
          arg: 'code',
        });
      case 'timeout':
        return createErrorResponse(message, ToolErrorCode.TIMEOUT, { tabId });
      case 'debugger_conflict':
        // Reaches here only when the conflict was unrecoverable at the CDP
        // path AND the scripting fallback also failed. CDP_BUSY is the
        // right signal — caller's recovery is "close DevTools and retry."
        return createErrorResponse(message, ToolErrorCode.CDP_BUSY, { tabId });
      case 'cdp_error':
        // CDP refuses to attach to restricted documents (chrome://, devtools://,
        // extension store, the new-tab page). Surface as INJECTION_FAILED so
        // the caller can branch the same way they'd branch on the
        // chrome.scripting fallback's restricted-URL refusal.
        if (/cannot access|cannot attach|restricted url|chrome:\/\//i.test(message)) {
          return createErrorResponse(message, ToolErrorCode.INJECTION_FAILED, { tabId });
        }
        // Generic CDP fault — not a user-code problem, no specific recovery.
        return createErrorResponse(message, ToolErrorCode.UNKNOWN, { tabId });
      case 'runtime_error':
      default:
        // User's code threw at runtime. Keep the JS-tool's structured
        // payload; envelope code wouldn't add anything useful here.
        return null;
    }
  }

  private buildSuccessResponse(
    tabId: number,
    result: ExecutionSuccess,
    startTime: number,
    warnings?: string[],
  ): ToolResult {
    const payload: JavaScriptToolResult = {
      success: true,
      tabId,
      engine: result.engine,
      result: result.output,
      truncated: result.truncated || undefined,
      redacted: result.redacted || undefined,
      warnings: warnings?.length ? warnings : undefined,
      metrics: { elapsedMs: Math.round(performance.now() - startTime) },
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: false,
    };
  }

  private buildErrorResponse(
    tabId: number,
    result: ExecutionFailure,
    startTime: number,
    warnings?: string[],
  ): ToolResult {
    const payload: JavaScriptToolResult = {
      success: false,
      tabId,
      engine: result.engine,
      error: result.error,
      warnings: warnings?.length ? warnings : undefined,
      metrics: { elapsedMs: Math.round(performance.now() - startTime) },
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: true,
    };
  }
}

export const javascriptTool = new JavaScriptTool();
