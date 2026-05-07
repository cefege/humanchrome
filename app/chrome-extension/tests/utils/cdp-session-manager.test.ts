/**
 * cdp-session-manager — DevTools-attached detection and per-command timeout.
 *
 * Covers the IMP-pulled-from-live-bug fix:
 *   chrome_computer scroll hung for 120s when DevTools was attached because
 *   the manager:
 *     1) didn't subscribe to chrome.debugger.onDetach, so its cached
 *        attached-by-us state went stale when DevTools opened, and
 *     2) sendCommand had no timeout, so a hijacked CDP session could hang
 *        until the bridge's outer 120s IPC timeout fired.
 *
 * The manager now (a) clears its state on onDetach + records the detach
 * reason, (b) fails fast on the next attach with a DevTools-named error,
 * and (c) caps every sendCommand with a configurable timeout that
 * normalises into the same DevTools error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only import so the manager module isn't loaded before the chrome
// mock is in place; the actual module is loaded with a dynamic import
// inside each test (after the mock is configured).
import type { cdpSessionManager as CdpSessionManagerExport } from '@/utils/cdp-session-manager';

type Manager = typeof CdpSessionManagerExport;

interface ChromeMock {
  runtime: { id: string };
  debugger: {
    onDetach: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
    onEvent: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    sendCommand: ReturnType<typeof vi.fn>;
    getTargets: ReturnType<typeof vi.fn>;
  };
}

let detachListener: ((source: { tabId?: number }, reason: string) => void) | undefined;
let chromeMock: ChromeMock;

async function loadManager(): Promise<Manager> {
  // Force a fresh module load so the manager's constructor re-installs the
  // detach listener against our current chrome mock.
  vi.resetModules();
  const mod = await import('@/utils/cdp-session-manager');
  return mod.cdpSessionManager;
}

beforeEach(() => {
  detachListener = undefined;
  chromeMock = {
    runtime: { id: 'test-extension-id' },
    debugger: {
      onDetach: {
        addListener: vi.fn().mockImplementation((fn) => {
          detachListener = fn;
        }),
        removeListener: vi.fn(),
      },
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      attach: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue({}),
      getTargets: vi.fn().mockResolvedValue([]),
    },
  };
  (globalThis as unknown as { chrome: ChromeMock }).chrome = chromeMock;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('cdp-session-manager: DevTools detection', () => {
  it('subscribes to chrome.debugger.onDetach at construction', async () => {
    await loadManager();
    expect(chromeMock.debugger.onDetach.addListener).toHaveBeenCalledTimes(1);
    expect(typeof detachListener).toBe('function');
  });

  it('clears cached state when Chrome detaches the session (e.g., DevTools opens)', async () => {
    const mgr = await loadManager();
    await mgr.attach(42, 'computer');
    expect(chromeMock.debugger.attach).toHaveBeenCalledTimes(1);

    // Simulate DevTools opening — Chrome detaches us with this reason.
    detachListener!({ tabId: 42 }, 'replaced_with_devtools');

    // Next attach must not silently re-use the stale state; it should
    // throw a DevTools-named error on the fast path.
    await expect(mgr.attach(42, 'computer')).rejects.toThrow(/DevTools.*tab 42/i);
    // Importantly, we should NOT have called Chrome's attach API again —
    // the early check fired first.
    expect(chromeMock.debugger.attach).toHaveBeenCalledTimes(1);
  });

  it('normalises Chrome\'s "Another debugger is already attached" into a DevTools-named error', async () => {
    const mgr = await loadManager();
    chromeMock.debugger.attach.mockRejectedValueOnce(
      new Error('Another debugger is already attached to this tab.'),
    );
    await expect(mgr.attach(7, 'computer')).rejects.toThrow(/DevTools.*tab 7/i);
  });

  it('flags an existing non-extension attachment from getTargets() as DevTools', async () => {
    const mgr = await loadManager();
    chromeMock.debugger.getTargets.mockResolvedValueOnce([
      { tabId: 99, attached: true /* no extensionId — DevTools front-end */ },
    ]);
    await expect(mgr.attach(99, 'computer')).rejects.toThrow(/DevTools.*tab 99/i);
    // Manager should not have called Chrome's attach API in this case.
    expect(chromeMock.debugger.attach).not.toHaveBeenCalled();
  });

  it('after DevTools closes, a fresh attach succeeds and clears the stale reason', async () => {
    const mgr = await loadManager();
    await mgr.attach(5, 'computer');
    detachListener!({ tabId: 5 }, 'replaced_with_devtools');
    // First attach attempt while DevTools is still open: fast-fail.
    await expect(mgr.attach(5, 'computer')).rejects.toThrow(/DevTools/i);
    // User closes DevTools and triggers a re-attach. Clear the stale
    // detach reason by calling detach() ourselves (the listener path
    // handled it, but the manager needs the reason cleared on success).
    // We model "DevTools closed" by deleting the lastDetachReason — the
    // public surface for this is the next successful attach. To exercise
    // it, we manually clear the reason via the listener with a different
    // event, then attach.
    detachListener!({ tabId: 5 }, 'target_closed'); // overwrites reason
    // attempt again; target_closed shouldn't gate attach the way
    // replaced_with_devtools does.
    await expect(mgr.attach(5, 'computer')).resolves.toBeUndefined();
    expect(chromeMock.debugger.attach).toHaveBeenCalledTimes(2);
  });
});

describe('cdp-session-manager: sendCommand timeout', () => {
  it('rejects with a DevTools-flavoured error when a CDP command hangs past the timeout', async () => {
    vi.useFakeTimers();
    const mgr = await loadManager();
    await mgr.attach(11, 'computer');

    // Make sendCommand never resolve — simulates DevTools hijacking the
    // protocol session.
    chromeMock.debugger.sendCommand.mockImplementation(() => new Promise(() => {}));

    const sendPromise = mgr.sendCommand(11, 'Input.dispatchMouseEvent', {}, 200);
    // Suppress unhandled-rejection warning while we advance the clock.
    sendPromise.catch(() => {});

    await vi.advanceTimersByTimeAsync(250);

    await expect(sendPromise).rejects.toThrow(/DevTools.*tab 11|did not return within/i);
  });

  it('clears cached state on timeout so the next attach re-checks the tab', async () => {
    vi.useFakeTimers();
    const mgr = await loadManager();
    await mgr.attach(13, 'computer');

    chromeMock.debugger.sendCommand.mockImplementation(() => new Promise(() => {}));

    const sendPromise = mgr.sendCommand(13, 'Input.dispatchMouseEvent', {}, 100);
    sendPromise.catch(() => {});
    await vi.advanceTimersByTimeAsync(150);
    await expect(sendPromise).rejects.toThrow();

    // Cached state should be gone — next attach will re-check getTargets()
    // and re-call chrome.debugger.attach() instead of fast-pathing on
    // attachedByUs.
    vi.useRealTimers();
    chromeMock.debugger.attach.mockClear();
    await mgr.attach(13, 'computer');
    expect(chromeMock.debugger.attach).toHaveBeenCalledTimes(1);
  });

  it('returns the result when the CDP command resolves before the timeout', async () => {
    const mgr = await loadManager();
    await mgr.attach(21, 'computer');
    chromeMock.debugger.sendCommand.mockResolvedValueOnce({ ok: true });
    const result = await mgr.sendCommand(21, 'Page.getLayoutMetrics', {}, 5000);
    expect(result).toEqual({ ok: true });
  });
});
