/**
 * Performance tool tests (IMP-0048, IMP-0051).
 *
 * The pre-fix code returned text-embedded "Error:" messages with
 * `isError: false`, so agents that branch on `isError` treated
 * pre-condition failures as success. These tests pin the new contract:
 *   - start trace twice without stopping → isError:true   (IMP-0048)
 *   - analyze with no recorded trace     → isError:true   (IMP-0051)
 *   - happy paths and the (still-tolerant) "stop with no session"
 *     case stay unchanged so we don't widen the fix beyond the two
 *     IDs that landed.
 *
 * The performance module holds `sessions` and `LAST_RESULTS` Maps at
 * module scope. To get clean per-test state we vi.resetModules() and
 * re-import the singletons. Trace lifecycle (Tracing.start →
 * Tracing.dataCollected → Tracing.tracingComplete) is event-driven,
 * so we capture the listener handed to chrome.debugger.onEvent and
 * fire the events from the test where needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// IMP-0157 / IMP-0160: `runWithContext` and `client-state` are imported
// dynamically inside the helpers below so each `vi.resetModules()` call
// in `loadTools` sees the same singleton the freshly-loaded tools see.

const TEST_CLIENT = 'perf-test-client';
const TEST_TAB_ID = 7;

const stubs = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  sendCommand: vi.fn(),
  sendNativeRequest: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: stubs.attach,
    detach: stubs.detach,
    sendCommand: stubs.sendCommand,
    withSession: vi.fn(),
  },
}));

vi.mock('@/entrypoints/background/native-host', () => ({
  sendNativeRequest: stubs.sendNativeRequest,
  initNativeHostListener: () => {},
}));

interface DebuggerListener {
  (source: chrome.debugger.Debuggee, method: string, params?: any): void;
}

let debuggerListeners: DebuggerListener[];

function installChromeMock() {
  debuggerListeners = [];
  // IMP-0157: the tool resolves the active tab through getOwnedTab now,
  // which calls chrome.tabs.get(tabId) on the caller's owned-tab pick.
  // Keep the legacy tabs.query stub for any non-migrated paths, but the
  // real source of truth is the claim in `beforeEach` + the per-test
  // runWithContext wrapper.
  (globalThis.chrome as any).tabs.query = vi
    .fn()
    .mockResolvedValue([{ id: TEST_TAB_ID, url: 'https://example.com/' }]);
  (globalThis.chrome as any).tabs.get = vi
    .fn()
    .mockResolvedValue({ id: TEST_TAB_ID, windowId: 1, url: 'https://example.com/' });
  (globalThis.chrome as any).storage = {
    session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
  };
  (globalThis.chrome as any).windows = {
    ...(((globalThis.chrome as any).windows ?? {})),
    onRemoved: { addListener: () => undefined },
  };
  (globalThis.chrome as any).debugger = {
    onEvent: {
      addListener: vi.fn((listener: DebuggerListener) => {
        debuggerListeners.push(listener);
      }),
      removeListener: vi.fn((listener: DebuggerListener) => {
        debuggerListeners = debuggerListeners.filter((l) => l !== listener);
      }),
    },
    onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  (globalThis.chrome as any).downloads = {
    download: vi.fn().mockResolvedValue(1),
    search: vi.fn().mockResolvedValue([{ filename: '/tmp/trace.json' }]),
  };
}

function fireDebuggerEvent(tabId: number, method: string, params?: any) {
  for (const listener of debuggerListeners) {
    listener({ tabId } as chrome.debugger.Debuggee, method, params);
  }
}

// IMP-0157: the performance tools import client-state for the
// dispatcher-shared `getOwnedTab` helper. Reseting modules forks a fresh
// client-state singleton, so the claim has to live inside loadTools().
async function loadTools() {
  vi.resetModules();
  const tools = await import('@/entrypoints/background/tools/browser/performance');
  // The freshly-loaded client-state module is what the tools reach into;
  // we must claim against that instance, not the one this test file
  // pinned at the top via the static import.
  const cs = await import('@/entrypoints/background/utils/client-state');
  cs._resetClientStateForTests();
  cs.claimTabForClient(TEST_CLIENT, TEST_TAB_ID, 1);
  return tools;
}

beforeEach(() => {
  stubs.attach.mockReset().mockResolvedValue(undefined);
  stubs.detach.mockReset().mockResolvedValue(undefined);
  stubs.sendCommand.mockReset().mockResolvedValue({ metrics: [] });
  stubs.sendNativeRequest.mockReset().mockResolvedValue({ success: false });
  installChromeMock();
});

afterEach(() => {
  vi.useRealTimers();
});

// Wraps a tool execution in the test client's request context so
// `getOwnedTab` (IMP-0157) resolves to TEST_TAB_ID. Must use the post-
// `vi.resetModules()` `request-context` module so the snapshot lands on
// the same singleton the freshly-loaded tools read from.
async function asClient<T>(fn: () => Promise<T>): Promise<T> {
  const rc = await import('@/entrypoints/background/utils/request-context');
  return rc.runWithContext({ clientId: TEST_CLIENT }, fn);
}

async function clearOwnedTabs() {
  const cs = await import('@/entrypoints/background/utils/client-state');
  cs._resetClientStateForTests();
}

describe('PerformanceStartTraceTool', () => {
  it('starts a trace and returns isError:false on the happy path', async () => {
    const { performanceStartTraceTool } = await loadTools();

    const res = await asClient(() => performanceStartTraceTool.execute({}));

    expect(res.isError).toBe(false);
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.success).toBe(true);
    // Confirm the CDP attach happened with the performance owner tag.
    expect(stubs.attach).toHaveBeenCalledWith(7, 'performance');
    // The Tracing.start CDP command should have fired with our category list.
    const tracingStart = stubs.sendCommand.mock.calls.find((c) => c[1] === 'Tracing.start');
    expect(tracingStart).toBeDefined();
  });

  it('IMP-0048: returns isError:true when a trace is already running', async () => {
    const { performanceStartTraceTool } = await loadTools();

    const first = await asClient(() => performanceStartTraceTool.execute({}));
    expect(first.isError).toBe(false);

    const second = await asClient(() => performanceStartTraceTool.execute({}));

    expect(second.isError).toBe(true);
    // Error envelope should clearly say "already" for human readers,
    // and isError:true is what agents branch on.
    expect((second.content[0] as any).text).toMatch(/already recording|already running/i);
  });

  it('returns TAB_NOT_FOUND when the caller has no owned tab', async () => {
    const { performanceStartTraceTool } = await loadTools();
    // Release the seeded tab so the resolver returns null (IMP-0157).
    await clearOwnedTabs();

    const res = await asClient(() => performanceStartTraceTool.execute({}));

    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/no active tab/i);
  });
});

describe('PerformanceAnalyzeInsightTool', () => {
  it('IMP-0051: returns isError:true when no trace has been recorded', async () => {
    const { performanceAnalyzeInsightTool } = await loadTools();

    const res = await asClient(() => performanceAnalyzeInsightTool.execute({}));

    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/no recorded trace/i);
  });

  it('returns TAB_NOT_FOUND when the caller has no owned tab', async () => {
    const { performanceAnalyzeInsightTool } = await loadTools();
    await clearOwnedTabs();

    const res = await asClient(() => performanceAnalyzeInsightTool.execute({}));

    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/no active tab/i);
  });
});

describe('PerformanceStopTraceTool — preserved behavior', () => {
  // The IMP-0048 backlog notes flagged the no-session path on stop as
  // "more debatable as idempotent no-ops" and explicitly scoped the
  // fix to start. Guard that boundary so a future cleanup doesn't widen
  // the fix beyond the two IDs that landed.
  it('keeps the existing isError:false response when no session exists', async () => {
    const { performanceStopTraceTool } = await loadTools();

    const res = await asClient(() => performanceStopTraceTool.execute({ saveToDownloads: false }));

    expect(res.isError).toBe(false);
    expect((res.content[0] as any).text).toMatch(/no performance trace session/i);
  });

  it('completes the stop+analyze round-trip when a recording session exists', async () => {
    const { performanceStartTraceTool, performanceStopTraceTool, performanceAnalyzeInsightTool } =
      await loadTools();

    // 1. Start
    const start = await asClient(() => performanceStartTraceTool.execute({}));
    expect(start.isError).toBe(false);

    // 2. Drive the trace event lifecycle
    fireDebuggerEvent(7, 'Tracing.dataCollected', { value: [{ name: 'foo' }, { name: 'foo' }] });

    // The stop call awaits a tracingComplete signal — fire it on the
    // next tick so the awaited promise can resolve naturally.
    queueMicrotask(() => fireDebuggerEvent(7, 'Tracing.tracingComplete'));

    const stop = await asClient(() => performanceStopTraceTool.execute({ saveToDownloads: false }));

    expect(stop.isError).toBe(false);
    const stopBody = JSON.parse((stop.content[0] as any).text);
    expect(stopBody.success).toBe(true);
    expect(stopBody.eventCount).toBe(2);

    // 3. After a successful stop, analyze should now succeed (post-IMP-0051
    //    it returns isError:true only when no trace exists for the tab).
    const analyze = await asClient(() => performanceAnalyzeInsightTool.execute({}));

    expect(analyze.isError).toBe(false);
    const analyzeBody = JSON.parse((analyze.content[0] as any).text);
    expect(analyzeBody.success).toBe(true);
    // Lightweight fallback aggregates by event name.
    expect(analyzeBody.topEventNames).toEqual([{ name: 'foo', count: 2 }]);
  });
});
