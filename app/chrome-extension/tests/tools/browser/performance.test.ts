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
  (globalThis.chrome as any).tabs.query = vi
    .fn()
    .mockResolvedValue([{ id: 7, url: 'https://example.com/' }]);
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

async function loadTools() {
  vi.resetModules();
  return await import('@/entrypoints/background/tools/browser/performance');
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

describe('PerformanceStartTraceTool', () => {
  it('starts a trace and returns isError:false on the happy path', async () => {
    const { performanceStartTraceTool } = await loadTools();

    const res = await performanceStartTraceTool.execute({});

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

    const first = await performanceStartTraceTool.execute({});
    expect(first.isError).toBe(false);

    const second = await performanceStartTraceTool.execute({});

    expect(second.isError).toBe(true);
    // Error envelope should clearly say "already" for human readers,
    // and isError:true is what agents branch on.
    expect((second.content[0] as any).text).toMatch(/already recording|already running/i);
  });

  it('returns TAB_NOT_FOUND when there is no active tab', async () => {
    const { performanceStartTraceTool } = await loadTools();
    (globalThis.chrome as any).tabs.query = vi.fn().mockResolvedValue([]);

    const res = await performanceStartTraceTool.execute({});

    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/no active tab/i);
  });
});

describe('PerformanceAnalyzeInsightTool', () => {
  it('IMP-0051: returns isError:true when no trace has been recorded', async () => {
    const { performanceAnalyzeInsightTool } = await loadTools();

    const res = await performanceAnalyzeInsightTool.execute({});

    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/no recorded trace/i);
  });

  it('returns TAB_NOT_FOUND when there is no active tab', async () => {
    const { performanceAnalyzeInsightTool } = await loadTools();
    (globalThis.chrome as any).tabs.query = vi.fn().mockResolvedValue([]);

    const res = await performanceAnalyzeInsightTool.execute({});

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

    const res = await performanceStopTraceTool.execute({ saveToDownloads: false });

    expect(res.isError).toBe(false);
    expect((res.content[0] as any).text).toMatch(/no performance trace session/i);
  });

  it('completes the stop+analyze round-trip when a recording session exists', async () => {
    const { performanceStartTraceTool, performanceStopTraceTool, performanceAnalyzeInsightTool } =
      await loadTools();

    // 1. Start
    const start = await performanceStartTraceTool.execute({});
    expect(start.isError).toBe(false);

    // 2. Drive the trace event lifecycle
    fireDebuggerEvent(7, 'Tracing.dataCollected', { value: [{ name: 'foo' }, { name: 'foo' }] });

    // The stop call awaits a tracingComplete signal — fire it on the
    // next tick so the awaited promise can resolve naturally.
    queueMicrotask(() => fireDebuggerEvent(7, 'Tracing.tracingComplete'));

    const stop = await performanceStopTraceTool.execute({ saveToDownloads: false });

    expect(stop.isError).toBe(false);
    const stopBody = JSON.parse((stop.content[0] as any).text);
    expect(stopBody.success).toBe(true);
    expect(stopBody.eventCount).toBe(2);

    // 3. After a successful stop, analyze should now succeed (post-IMP-0051
    //    it returns isError:true only when no trace exists for the tab).
    const analyze = await performanceAnalyzeInsightTool.execute({});

    expect(analyze.isError).toBe(false);
    const analyzeBody = JSON.parse((analyze.content[0] as any).text);
    expect(analyzeBody.success).toBe(true);
    // Lightweight fallback aggregates by event name.
    expect(analyzeBody.topEventNames).toEqual([{ name: 'foo', count: 2 }]);
  });
});
