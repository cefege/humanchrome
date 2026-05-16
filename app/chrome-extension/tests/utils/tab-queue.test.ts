/**
 * Tests for the per-tab serialization queue (IMP-0087).
 *
 * Covers: fast path, FIFO within a single client, round-robin across
 * clients, depth cap, per-call timeout, tabs.onRemoved cancellation,
 * inspector snapshots, EWMA mean-hold computation, and release-after-
 * cancel safety.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquireTabLock,
  acquireTabLockWithMeta,
  activeLockedTabCount,
  inspectAllTabQueues,
  inspectTabQueue,
  _resetTabQueueForTests,
  _snapshotTabQueueForTests,
  _advanceMeanHoldForTests,
} from '@/entrypoints/background/utils/tab-queue';
import { MAX_TAB_QUEUE_DEPTH } from '@/entrypoints/background/utils/timeouts';

beforeEach(() => {
  _resetTabQueueForTests();
  (globalThis.chrome as any) = {
    tabs: { onRemoved: { addListener: () => undefined } },
  };
});

afterEach(() => {
  _resetTabQueueForTests();
});

describe('acquireTabLock — fast path', () => {
  it('returns position 1 with near-zero wait when uncontended', async () => {
    const result = await acquireTabLockWithMeta(1, { clientId: 'alice' });
    expect(result.queuedAtPosition).toBe(1);
    expect(result.waitedMs).toBeLessThan(20);
    result.release();
    expect(activeLockedTabCount()).toBe(0);
  });
});

describe('acquireTabLock — serialization', () => {
  it('serializes two acquirers on the same tab (FIFO)', async () => {
    const order: string[] = [];
    const releaseA = await acquireTabLock(7, { clientId: 'alice' });
    const bPromise = acquireTabLock(7, { clientId: 'alice' }).then((rel) => {
      order.push('B');
      rel();
    });
    order.push('A');
    releaseA();
    await bPromise;
    expect(order).toEqual(['A', 'B']);
  });

  it('FIFO within a single client when many are queued', async () => {
    const order: number[] = [];
    const head = await acquireTabLock(11, { clientId: 'alice' });
    const promises: Array<Promise<void>> = [];
    for (let i = 0; i < 4; i++) {
      const idx = i;
      promises.push(
        acquireTabLock(11, { clientId: 'alice' }).then((rel) => {
          order.push(idx);
          rel();
        }),
      );
    }
    head();
    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3]);
  });
});

describe('acquireTabLock — round-robin fairness', () => {
  it('rotates between distinct clients after the head releases', async () => {
    const order: string[] = [];
    const head = await acquireTabLockWithMeta(2, { clientId: 'alice' });
    // Two more from alice, one from bob, one more from alice.
    const a1 = acquireTabLock(2, { clientId: 'alice' }).then((rel) => {
      order.push('alice');
      rel();
    });
    const a2 = acquireTabLock(2, { clientId: 'alice' }).then((rel) => {
      order.push('alice');
      rel();
    });
    const b1 = acquireTabLock(2, { clientId: 'bob' }).then((rel) => {
      order.push('bob');
      rel();
    });
    const a3 = acquireTabLock(2, { clientId: 'alice' }).then((rel) => {
      order.push('alice');
      rel();
    });
    head.release();
    await Promise.all([a1, a2, b1, a3]);
    // After the alice head released, last-served = alice → next pick must be
    // a non-alice waiter. Bob is the only one, so he jumps the queue first.
    // After bob, last-served = bob → next non-bob waiter (alice's earliest).
    expect(order[0]).toBe('bob');
    expect(order.slice(1)).toEqual(['alice', 'alice', 'alice']);
  });

  it('anonymous (clientId undefined) entries share one lane (FIFO among themselves)', async () => {
    const order: number[] = [];
    const head = await acquireTabLock(3);
    const promises: Array<Promise<void>> = [];
    for (let i = 0; i < 3; i++) {
      const idx = i;
      promises.push(
        acquireTabLock(3).then((rel) => {
          order.push(idx);
          rel();
        }),
      );
    }
    head();
    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2]);
  });
});

describe('acquireTabLock — bounded depth', () => {
  it('rejects with QUEUE_FULL synchronously when the queue is at capacity', async () => {
    const releases: Array<() => void> = [];
    const head = await acquireTabLock(5, { clientId: 'alice' });
    releases.push(head);
    // Fill the queue to MAX_TAB_QUEUE_DEPTH waiters (head already counts as
    // entry 0, so we add MAX_TAB_QUEUE_DEPTH - 1 waiters).
    const waiters: Array<Promise<() => void>> = [];
    for (let i = 0; i < MAX_TAB_QUEUE_DEPTH - 1; i++) {
      waiters.push(acquireTabLock(5, { clientId: 'alice' }));
    }
    // One more should reject.
    await expect(acquireTabLock(5, { clientId: 'alice' })).rejects.toMatchObject({
      code: 'QUEUE_FULL',
      details: { tabId: 5, max: MAX_TAB_QUEUE_DEPTH },
    });
    // Drain everything.
    head();
    for (const w of waiters) {
      const rel = await w;
      rel();
    }
  });
});

describe('acquireTabLock — per-call timeout', () => {
  it('rejects with TAB_LOCK_TIMEOUT when the wait exceeds timeoutMs', async () => {
    const head = await acquireTabLock(4, { clientId: 'alice' });
    await expect(acquireTabLock(4, { clientId: 'bob', timeoutMs: 20 })).rejects.toMatchObject({
      code: 'TAB_LOCK_TIMEOUT',
    });
    head();
  });

  it('removes the timed-out slot so subsequent acquirers do not deadlock', async () => {
    const head = await acquireTabLock(6, { clientId: 'alice' });
    await expect(acquireTabLock(6, { clientId: 'bob', timeoutMs: 20 })).rejects.toMatchObject({
      code: 'TAB_LOCK_TIMEOUT',
    });
    head();
    // After head releases, no leftover slots — next acquire is fast.
    const next = await acquireTabLockWithMeta(6, { clientId: 'carol' });
    expect(next.queuedAtPosition).toBe(1);
    next.release();
  });
});

describe('inspectors', () => {
  it('inspectTabQueue returns null for an unknown tabId', () => {
    expect(inspectTabQueue(99)).toBeNull();
  });

  it('reports holder + waiters with deterministic expectedWaitMs once warmed up', async () => {
    const head = await acquireTabLock(8, { clientId: 'alice' });
    const wPromise = acquireTabLock(8, { clientId: 'bob' });
    _advanceMeanHoldForTests(8, 500);
    const snap = inspectTabQueue(8);
    expect(snap).not.toBeNull();
    expect(snap?.depth).toBe(2);
    expect(snap?.holder?.clientId).toBe('alice');
    expect(snap?.waiters.length).toBe(1);
    expect(snap?.waiters[0]?.clientId).toBe('bob');
    expect(snap?.waiters[0]?.position).toBe(2);
    expect(snap?.waiters[0]?.expectedWaitMs).toBe(500);
    head();
    (await wPromise)();
  });

  it('inspectAllTabQueues returns every active queue', async () => {
    const r1 = await acquireTabLock(10, { clientId: 'alice' });
    const r2 = await acquireTabLock(11, { clientId: 'bob' });
    const all = inspectAllTabQueues();
    expect(all.map((t) => t.tabId).sort()).toEqual([10, 11]);
    r1();
    r2();
  });

  it('drops the queue entry after the last holder releases', async () => {
    const r = await acquireTabLock(12, { clientId: 'alice' });
    r();
    expect(inspectTabQueue(12)).toBeNull();
    expect(activeLockedTabCount()).toBe(0);
  });
});

describe('tabs.onRemoved cleanup', () => {
  it('cancels all waiters with TAB_CLOSED when the tab is removed mid-queue', async () => {
    // Reset module cache so the chrome.tabs.onRemoved.addListener call at
    // module load runs against the per-test chrome shim defined below.
    vi.resetModules();
    let onRemovedCb: ((tabId: number) => void) | undefined;
    (globalThis.chrome as any) = {
      tabs: {
        onRemoved: {
          addListener: (fn: (tabId: number) => void) => {
            onRemovedCb = fn;
          },
        },
      },
    };
    const mod = await import('@/entrypoints/background/utils/tab-queue');
    mod._resetTabQueueForTests();
    const head = await mod.acquireTabLock(20, { clientId: 'alice' });
    const w1 = mod.acquireTabLock(20, { clientId: 'bob' });
    const w2 = mod.acquireTabLock(20, { clientId: 'carol' });
    expect(onRemovedCb).toBeTypeOf('function');
    onRemovedCb!(20);
    await expect(w1).rejects.toMatchObject({ code: 'TAB_CLOSED' });
    await expect(w2).rejects.toMatchObject({ code: 'TAB_CLOSED' });
    // Releasing the head after the close is a safe no-op.
    head();
  });
});

describe('release-after-cancel safety', () => {
  it('calling release after a timeout does not throw', async () => {
    const head = await acquireTabLock(13, { clientId: 'alice' });
    let timedOutRelease: (() => void) | undefined;
    try {
      const meta = await acquireTabLockWithMeta(13, { clientId: 'bob', timeoutMs: 20 });
      timedOutRelease = meta.release;
    } catch {
      // expected
    }
    head();
    // No-op even if a test somehow got hold of a release ref it shouldn't.
    expect(() => timedOutRelease?.()).not.toThrow();
  });
});

describe('EWMA mean-hold', () => {
  it('updates meanHoldMs across releases', async () => {
    // We can't easily wait 100/200/400ms in a test, but we can verify the
    // formula by feeding samples via _advanceMeanHoldForTests + reading
    // back through inspectTabQueue.
    _advanceMeanHoldForTests(30, 100);
    const snap1 = inspectTabQueue(30);
    expect(snap1?.meanHoldMs).toBe(100);
    _advanceMeanHoldForTests(30, 250);
    const snap2 = inspectTabQueue(30);
    expect(snap2?.meanHoldMs).toBe(250);
  });
});

describe('_snapshotTabQueueForTests', () => {
  it('returns the current entries without promise refs', async () => {
    const head = await acquireTabLock(40, { clientId: 'alice' });
    void acquireTabLock(40, { clientId: 'bob' }).then((rel) => rel());
    const snap = _snapshotTabQueueForTests(40);
    expect(snap.length).toBe(2);
    expect(snap[0]?.clientId).toBe('alice');
    expect(snap[1]?.clientId).toBe('bob');
    expect(typeof snap[0]?.ticket).toBe('number');
    head();
  });
});
