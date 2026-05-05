/**
 * Per-tool-call request context.
 *
 * The dispatch (entrypoints/background/tools/index.ts) sets the active
 * `requestId` / `clientId` for the duration of a single tool execution so
 * downstream helpers (BaseBrowserToolExecutor.sendMessageToTab, etc.) can
 * tag outbound messages with the same correlation id the bridge logged.
 *
 * Service workers don't have AsyncLocalStorage, but tool dispatch is
 * single-threaded per call, so a module-level snapshot updated synchronously
 * around `await` boundaries is good enough — we use `runWithContext` to push
 * /pop a snapshot atomically, which protects against interleaved tool calls.
 */

export interface RequestContext {
  requestId?: string;
  clientId?: string;
  tool?: string;
  tabId?: number;
}

let current: RequestContext | undefined;

export function getCurrentRequestContext(): RequestContext | undefined {
  return current;
}

/**
 * Run `fn` with `ctx` as the active request context. Stack-safe across
 * nested awaits: prior context is restored after `fn` resolves or rejects.
 */
export async function runWithContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  const previous = current;
  current = ctx;
  try {
    return await fn();
  } finally {
    current = previous;
  }
}
