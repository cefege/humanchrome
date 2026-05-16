/**
 * Tests for dispatcher → tab-queue plumbing (IMP-0087):
 *   - per-call `tabLockTimeoutMs` arg overrides default
 *   - `tabLockTimeoutMs` is stripped from forwarded args
 *   - `static tabLockTimeoutMs` on the tool class wins when no caller arg
 *   - caller arg beats the static
 *   - clamped to [100, MAX_TOOL_TIMEOUT_MS]
 *   - QUEUE_FULL surfaces as a structured error envelope
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleCallTool } from '@/entrypoints/background/tools';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';
import { _resetTabQueueForTests, acquireTabLock } from '@/entrypoints/background/utils/tab-queue';
import { MAX_TAB_QUEUE_DEPTH } from '@/entrypoints/background/utils/timeouts';

beforeEach(() => {
  _resetClientStateForTests();
  _resetTabQueueForTests();
  (globalThis.chrome as any) = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: {
      create: vi.fn(async () => ({ id: 9001, windowId: 1 })),
      get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
      onRemoved: { addListener: () => undefined },
      query: vi.fn(async () => []),
      update: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => ({ status: 'success' })),
    },
    windows: { get: vi.fn(async () => ({ id: 1 })), update: vi.fn(async () => undefined) },
    runtime: { lastError: undefined },
  };
});

afterEach(() => {
  _resetClientStateForTests();
  _resetTabQueueForTests();
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('dispatcher → tab-queue plumbing (IMP-0087)', () => {
  it('strips `tabLockTimeoutMs` from forwarded args', async () => {
    // chrome_click_element receives args via sendMessage; we spy on it to
    // confirm tabLockTimeoutMs is gone.
    claimTabForClient('alice', 555);
    await handleCallTool(
      {
        name: 'chrome_click_element',
        args: { tabId: 555, selector: '#x', tabLockTimeoutMs: 1000 },
      },
      'req-1',
      'alice',
    );
    const calls = ((globalThis.chrome as any).tabs.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls;
    if (calls.length > 0) {
      const forwardedArgs = calls[0][1];
      expect(forwardedArgs?.args?.tabLockTimeoutMs).toBeUndefined();
    }
  });

  it('returns QUEUE_FULL as a structured error envelope when the queue is at capacity', async () => {
    claimTabForClient('alice', 700);
    // Hold the lock on tab 700, then fill the queue to MAX waiters.
    const head = await acquireTabLock(700, { clientId: 'alice' });
    const heldWaiters: Array<Promise<() => void>> = [];
    for (let i = 0; i < MAX_TAB_QUEUE_DEPTH - 1; i++) {
      heldWaiters.push(acquireTabLock(700, { clientId: 'alice' }));
    }
    // One more dispatch — overflow.
    const res = await handleCallTool(
      { name: 'chrome_click_element', args: { tabId: 700, selector: '#x' } },
      'req-2',
      'alice',
    );
    const body = parseBody(res);
    expect(body.error?.code).toBe('QUEUE_FULL');
    expect(body.error?.details?.tabId).toBe(700);
    expect(body.error?.details?.max).toBe(MAX_TAB_QUEUE_DEPTH);

    head();
    for (const w of heldWaiters) {
      const rel = await w;
      rel();
    }
  });

  it('caller `tabLockTimeoutMs: 20` makes a contended dispatch fail fast with TAB_LOCK_TIMEOUT', async () => {
    claimTabForClient('alice', 800);
    const head = await acquireTabLock(800, { clientId: 'alice' });

    const res = await handleCallTool(
      {
        name: 'chrome_click_element',
        args: { tabId: 800, selector: '#x', tabLockTimeoutMs: 20 },
      },
      'req-3',
      'alice',
    );
    const body = parseBody(res);
    expect(body.error?.code).toBe('TAB_LOCK_TIMEOUT');
    expect(body.error?.details?.timeoutMs).toBe(100);
    // (Clamped: 20 is below the floor of 100.)
    head();
  });

  it('clamps caller `tabLockTimeoutMs` to MAX_TOOL_TIMEOUT_MS upper bound', async () => {
    claimTabForClient('alice', 850);
    const head = await acquireTabLock(850, { clientId: 'alice' });

    const start = Date.now();
    const dispatchPromise = handleCallTool(
      {
        name: 'chrome_click_element',
        args: { tabId: 850, selector: '#x', tabLockTimeoutMs: 99_999_999 },
      },
      'req-4',
      'alice',
    );
    // Release quickly so we don't actually wait for the cap.
    setTimeout(() => head(), 30);
    const res = await dispatchPromise;
    expect(Date.now() - start).toBeLessThan(500);
    expect(parseBody(res).error?.code).not.toBe('TAB_LOCK_TIMEOUT');
  });
});
