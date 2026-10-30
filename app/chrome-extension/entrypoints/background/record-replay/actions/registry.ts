/**
 * Action Registry — handler registry and execution pipeline.
 * Dynamic register/unregister, before/after hooks, retry+timeout, type-safe.
 */

import { replayPolicy, workflowPolicy } from 'humanchrome-shared';
import type {
  Action,
  ActionError,
  ActionErrorCode,
  ActionExecutionContext,
  ActionExecutionResult,
  ActionHandler,
  EdgeLabel,
  ElementTarget,
  ExecutableAction,
  ExecutableActionType,
  FrameTarget,
  JsonValue,
  NonEmptyArray,
  Resolvable,
  RetryPolicy,
  SelectorCandidate,
  TimeoutPolicy,
  ValidationResult,
  VariableStore,
} from './types';

// ================================
// Types
// ================================

type AnyExecutableAction = {
  [T in ExecutableActionType]: ExecutableAction<T>;
}[ExecutableActionType];
type AnyExecutableHandler = { [T in ExecutableActionType]: ActionHandler<T> }[ExecutableActionType];

export interface BeforeExecuteArgs<T extends ExecutableActionType> {
  ctx: ActionExecutionContext;
  action: ExecutableAction<T>;
  handler: ActionHandler<T>;
  attempt: number;
}

export type BeforeExecuteHook = <T extends ExecutableActionType>(
  args: BeforeExecuteArgs<T>,
) => void | ActionExecutionResult<T> | Promise<void | ActionExecutionResult<T>>;

export interface AfterExecuteArgs<T extends ExecutableActionType> {
  ctx: ActionExecutionContext;
  action: ExecutableAction<T>;
  handler: ActionHandler<T>;
  result: ActionExecutionResult<T>;
  attempt: number;
}

export type AfterExecuteHook = <T extends ExecutableActionType>(
  args: AfterExecuteArgs<T>,
) => void | ActionExecutionResult<T> | Promise<void | ActionExecutionResult<T>>;

export interface ActionRegistryHooks {
  beforeExecute?: BeforeExecuteHook;
  afterExecute?: AfterExecuteHook;
}

// ================================
// Utilities
// ================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toNonEmptyArray(value: string[], fallback: string): NonEmptyArray<string> {
  return (value.length > 0 ? value : [fallback]) as NonEmptyArray<string>;
}

const ACTION_ERROR_CODES: ReadonlyArray<ActionErrorCode> = [
  'VALIDATION_ERROR',
  'TIMEOUT',
  'TAB_NOT_FOUND',
  'FRAME_NOT_FOUND',
  'TARGET_NOT_FOUND',
  'ELEMENT_NOT_VISIBLE',
  'NAVIGATION_FAILED',
  'NETWORK_REQUEST_FAILED',
  'DOWNLOAD_FAILED',
  'ASSERTION_FAILED',
  'SCRIPT_FAILED',
  'UNKNOWN',
] as const;

function isActionErrorCode(value: unknown): value is ActionErrorCode {
  return typeof value === 'string' && (ACTION_ERROR_CODES as ReadonlyArray<string>).includes(value);
}

function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (isRecord(e) && typeof e.message === 'string') return e.message;
  return 'Unknown error';
}

function toActionError(e: unknown, fallbackCode: ActionErrorCode = 'UNKNOWN'): ActionError {
  if (isRecord(e) && isActionErrorCode(e.code) && typeof e.message === 'string') {
    return { code: e.code, message: e.message, data: undefined };
  }
  return { code: fallbackCode, message: toErrorMessage(e) };
}

export function ok(): ValidationResult {
  return { ok: true };
}

export function invalid(...errors: string[]): ValidationResult {
  return { ok: false, errors: toNonEmptyArray(errors.filter(Boolean), 'Validation failed') };
}

export function failed<T extends ExecutableActionType>(
  code: ActionErrorCode,
  message: string,
): ActionExecutionResult<T> {
  return { status: 'failed', error: { code, message } };
}

function sleep(ms: number): Promise<void> {
  const safe = Math.max(0, Math.floor(ms));
  return new Promise((resolve) => setTimeout(resolve, safe));
}

// ================================
// Resolvable resolvers
// ================================

export function tryResolveJson(
  value: Resolvable<JsonValue>,
  vars: VariableStore,
): { ok: true; value: JsonValue } | { ok: false; error: string } {
  return replayPolicy.replayResolveJson<JsonValue>(
    value,
    vars as unknown as Record<string, unknown>,
  );
}

export function tryResolveString(
  value: Resolvable<string>,
  vars: VariableStore,
): { ok: true; value: string } | { ok: false; error: string } {
  return replayPolicy.replayResolveString(value, vars as unknown as Record<string, unknown>);
}

export function tryResolveNumber(
  value: Resolvable<number>,
  vars: VariableStore,
): { ok: true; value: number } | { ok: false; error: string } {
  return replayPolicy.replayResolveNumber(value, vars as unknown as Record<string, unknown>);
}

/** Resolve a generic JSON value for script/http handlers through the Rust resolver. */
export const tryResolveValue = tryResolveJson;

// ================================
// Retry + timeout logic
// ================================

function shouldRetry(policy: RetryPolicy | undefined, error: ActionError | undefined): boolean {
  return replayPolicy.replayShouldRetryAction(
    policy !== undefined,
    policy?.retries ?? 0,
    error?.code,
    policy?.retryOn,
  );
}

function computeRetryDelayMs(policy: RetryPolicy, retryIndex: number): number {
  return workflowPolicy.workflowLegacyRetryDelay(policy, retryIndex, Math.random());
}

async function runWithTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number | undefined,
): Promise<{ ok: true; value: T } | { ok: false; error: ActionError }> {
  if (timeoutMs === undefined) {
    try {
      return { ok: true, value: await run() };
    } catch (e) {
      return { ok: false, error: toActionError(e) };
    }
  }

  const ms = replayPolicy.replayTimeoutMs(timeoutMs);
  if (ms === 0) return { ok: false, error: { code: 'TIMEOUT', message: 'Timeout reached' } };

  return await new Promise((resolve) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      resolve({ ok: false, error: { code: 'TIMEOUT', message: 'Timeout reached' } });
    }, ms);

    run()
      .then((value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      })
      .catch((e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: toActionError(e) });
      });
  });
}

// ================================
// ActionRegistry class
// ================================

export class ActionRegistry {
  private readonly handlers: { [T in ExecutableActionType]?: ActionHandler<T> } = {};
  private readonly beforeHooks: BeforeExecuteHook[] = [];
  private readonly afterHooks: AfterExecuteHook[] = [];

  register<T extends ExecutableActionType>(
    handler: ActionHandler<T>,
    options?: { override?: boolean },
  ): void {
    const override = options?.override !== false;
    const existing = this.handlers[handler.type];
    if (existing && !override) {
      throw new Error(`Handler already registered for type: ${handler.type}`);
    }
    // Type assertion needed due to TypeScript mapped type limitation

    (this.handlers as Record<ExecutableActionType, ActionHandler<any>>)[handler.type] = handler;
  }

  unregister<T extends ExecutableActionType>(type: T): boolean {
    const exists = this.handlers[type] !== undefined;
    delete this.handlers[type];
    return exists;
  }

  get<T extends ExecutableActionType>(type: T): ActionHandler<T> | undefined {
    return this.handlers[type];
  }

  has(type: ExecutableActionType): boolean {
    return this.handlers[type] !== undefined;
  }

  list(): ReadonlyArray<AnyExecutableHandler> {
    const arr = Object.values(this.handlers).filter(
      (h): h is AnyExecutableHandler => h !== undefined,
    );
    return arr;
  }

  onBeforeExecute(hook: BeforeExecuteHook): () => void {
    this.beforeHooks.push(hook);
    return () => {
      const idx = this.beforeHooks.indexOf(hook);
      if (idx >= 0) this.beforeHooks.splice(idx, 1);
    };
  }

  onAfterExecute(hook: AfterExecuteHook): () => void {
    this.afterHooks.push(hook);
    return () => {
      const idx = this.afterHooks.indexOf(hook);
      if (idx >= 0) this.afterHooks.splice(idx, 1);
    };
  }

  use(hooks: ActionRegistryHooks): () => void {
    const disposers: Array<() => void> = [];
    if (hooks.beforeExecute) disposers.push(this.onBeforeExecute(hooks.beforeExecute));
    if (hooks.afterExecute) disposers.push(this.onAfterExecute(hooks.afterExecute));
    return () => {
      for (const d of disposers) d();
    };
  }

  validate<T extends ExecutableActionType>(action: ExecutableAction<T>): ValidationResult {
    const handler = this.get(action.type);
    if (!handler) return invalid(`Unsupported action type: ${String(action.type)}`);
    if (!handler.validate) return ok();
    return handler.validate(action);
  }

  async execute<T extends ExecutableActionType>(
    ctx: ActionExecutionContext,
    action: ExecutableAction<T>,
  ): Promise<ActionExecutionResult<T>> {
    const startedAt = Date.now();

    if (action.disabled) {
      return { status: 'skipped', durationMs: Date.now() - startedAt };
    }

    const handler = this.get(action.type);
    if (!handler) {
      return {
        status: 'failed',
        error: {
          code: 'VALIDATION_ERROR',
          message: `Unsupported action type: ${String(action.type)}`,
        },
        durationMs: Date.now() - startedAt,
      };
    }

    const v = this.validate(action);
    if (!v.ok) {
      let result: ActionExecutionResult<T> = {
        status: 'failed',
        error: { code: 'VALIDATION_ERROR', message: v.errors.join(', ') },
      };

      for (const hook of this.afterHooks) {
        try {
          const maybe = await hook({ ctx, action, handler, result, attempt: 0 });
          if (maybe) result = maybe;
        } catch (e) {
          try {
            ctx.log(`afterExecute hook failed: ${toErrorMessage(e)}`, 'warn');
          } catch {
            // ignore
          }
        }
      }

      result.durationMs = Date.now() - startedAt;
      return result;
    }

    const retryPolicy = action.policy?.retry;
    const timeoutPolicy = action.policy?.timeout;
    const maxAttempts = replayPolicy.replayActionMaxAttempts(retryPolicy?.retries ?? 0);

    const actionDeadline =
      timeoutPolicy && timeoutPolicy.ms > 0 && (timeoutPolicy.scope ?? 'attempt') === 'action'
        ? startedAt + timeoutPolicy.ms
        : undefined;

    const remainingActionMs = () =>
      actionDeadline === undefined ? undefined : Math.max(0, actionDeadline - Date.now());

    let last: ActionExecutionResult<T> | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const attemptTimeoutMs: number | undefined = (() => {
        if (!timeoutPolicy || timeoutPolicy.ms <= 0) return undefined;
        const scope = timeoutPolicy.scope ?? 'attempt';
        if (scope === 'attempt') return timeoutPolicy.ms;
        return remainingActionMs();
      })();

      if (attemptTimeoutMs !== undefined && attemptTimeoutMs <= 0) {
        last = failed<T>('TIMEOUT', 'Timeout reached');
        break;
      }

      // beforeExecute hooks may short-circuit by returning a result
      let shortCircuited: ActionExecutionResult<T> | undefined;
      for (const hook of this.beforeHooks) {
        try {
          const maybe = await hook({ ctx, action, handler, attempt });
          if (maybe) {
            shortCircuited = maybe;
            break;
          }
        } catch (e) {
          try {
            ctx.log(`beforeExecute hook failed: ${toErrorMessage(e)}`, 'warn');
          } catch {
            // ignore
          }
        }
      }

      const runOutcome =
        shortCircuited ??
        (await (async () => {
          const out = await runWithTimeout(() => handler.run(ctx, action), attemptTimeoutMs);
          if (!out.ok) return failed<T>(out.error.code, out.error.message);

          const result = out.value ?? ({} as ActionExecutionResult<T>);
          if (result.status === 'failed' && !result.error) {
            return { ...result, error: { code: 'UNKNOWN' as const, message: 'Action failed' } };
          }
          return result;
        })());

      let result: ActionExecutionResult<T> = runOutcome;

      // afterExecute hooks may replace the result
      for (const hook of this.afterHooks) {
        try {
          const maybe = await hook({ ctx, action, handler, result, attempt });
          if (maybe) result = maybe;
        } catch (e) {
          try {
            ctx.log(`afterExecute hook failed: ${toErrorMessage(e)}`, 'warn');
          } catch {
            // ignore
          }
        }
      }

      last = result;

      if (result.status !== 'failed') break;

      const canRetry = attempt < maxAttempts - 1 && shouldRetry(retryPolicy, result.error);
      if (!canRetry) break;

      const delay = computeRetryDelayMs(retryPolicy!, attempt);
      if (
        actionDeadline !== undefined &&
        remainingActionMs() !== undefined &&
        (remainingActionMs() as number) < delay
      ) {
        break;
      }

      try {
        ctx.log(`Retrying action "${action.type}" (attempt ${attempt + 1}/${maxAttempts})`, 'warn');
      } catch {
        // ignore
      }

      if (delay > 0) await sleep(delay);
    }

    const finalResult: ActionExecutionResult<T> =
      last ??
      ({
        status: 'failed',
        error: { code: 'UNKNOWN', message: 'Action execution produced no result' },
      } as ActionExecutionResult<T>);

    finalResult.durationMs = Date.now() - startedAt;
    return finalResult;
  }
}

export function createActionRegistry(): ActionRegistry {
  return new ActionRegistry();
}
