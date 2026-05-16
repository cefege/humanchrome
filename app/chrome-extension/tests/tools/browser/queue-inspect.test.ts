/**
 * Tests for chrome_queue_inspect (IMP-0087).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queueInspectTool } from '@/entrypoints/background/tools/browser/queue-inspect';
import {
  _resetTabQueueForTests,
  _advanceMeanHoldForTests,
  acquireTabLock,
} from '@/entrypoints/background/utils/tab-queue';

beforeEach(() => {
  _resetTabQueueForTests();
  (globalThis.chrome as any) = {
    tabs: { onRemoved: { addListener: () => undefined } },
  };
});

afterEach(() => {
  _resetTabQueueForTests();
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_queue_inspect', () => {
  it('returns { tabs: [] } when no queues exist', async () => {
    const body = parseBody(await queueInspectTool.execute({}));
    expect(body.tabs).toEqual([]);
  });

  it('errors INVALID_ARGS when tabId is not a number', async () => {
    const body = parseBody(await queueInspectTool.execute({ tabId: 'abc' as any }));
    expect(body.error?.code).toBe('INVALID_ARGS');
    expect(body.error?.details?.arg).toBe('tabId');
  });

  it('returns { tabs: [] } when the queried tabId has no queue', async () => {
    const body = parseBody(await queueInspectTool.execute({ tabId: 999 }));
    expect(body.tabs).toEqual([]);
  });

  it('reports the holder and waiters for a contended tab', async () => {
    const release = await acquireTabLock(1, { clientId: 'alice' });
    void acquireTabLock(1, { clientId: 'bob' }).then((rel) => rel());
    void acquireTabLock(1, { clientId: 'carol' }).then((rel) => rel());
    _advanceMeanHoldForTests(1, 200);

    const body = parseBody(await queueInspectTool.execute({ tabId: 1 }));
    expect(body.tabs.length).toBe(1);
    const snap = body.tabs[0];
    expect(snap.tabId).toBe(1);
    expect(snap.depth).toBe(3);
    expect(snap.meanHoldMs).toBe(200);
    expect(snap.holder.clientId).toBe('alice');
    expect(snap.waiters.length).toBe(2);
    expect(snap.waiters[0]).toMatchObject({
      clientId: 'bob',
      position: 2,
      expectedWaitMs: 200,
    });
    expect(snap.waiters[1]).toMatchObject({
      clientId: 'carol',
      position: 3,
      expectedWaitMs: 400,
    });
    release();
  });

  it('returns every active queue when no tabId is supplied', async () => {
    const r1 = await acquireTabLock(10, { clientId: 'alice' });
    const r2 = await acquireTabLock(11, { clientId: 'bob' });
    const body = parseBody(await queueInspectTool.execute({}));
    const ids = body.tabs.map((t: any) => t.tabId).sort();
    expect(ids).toEqual([10, 11]);
    r1();
    r2();
  });

  it('reports clientId: null for anonymous entries', async () => {
    const release = await acquireTabLock(20);
    const body = parseBody(await queueInspectTool.execute({ tabId: 20 }));
    expect(body.tabs[0].holder.clientId).toBeNull();
    release();
  });

  it('falls back to expectedWaitMs = position * 250 without EWMA samples', async () => {
    const release = await acquireTabLock(30, { clientId: 'alice' });
    void acquireTabLock(30, { clientId: 'bob' }).then((rel) => rel());
    const body = parseBody(await queueInspectTool.execute({ tabId: 30 }));
    expect(body.tabs[0].waiters[0].expectedWaitMs).toBe(250);
    release();
  });

  it('output is JSON-parseable', async () => {
    const res = await queueInspectTool.execute({});
    const block = res.content[0] as { type: string; text: string };
    expect(() => JSON.parse(block.text)).not.toThrow();
    expect(res.isError).toBe(false);
  });
});
