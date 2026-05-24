/**
 * Contract: per-client recording session isolation (IMP-0165).
 *
 * Pre-IMP-0165, `recordingSession` was a single module-scope singleton —
 * two MCP clients calling the recorder concurrently would clobber each
 * other's state (origin tab, active tabs, captured steps, status).
 *
 * Post-IMP-0165, the `recordingSession` import is a Proxy that routes
 * to a per-clientId `RecordingSessionManager`. These tests assert:
 *   1. The Proxy resolves to the *caller's* manager based on request
 *      context — two clients see independent state.
 *   2. Test helpers (`_listRecordingSessionsForTest`,
 *      `_resetRecordingSessionsForTest`) make the per-client state
 *      inspectable for future regression tests.
 *   3. The no-request-context path routes to a shared `__system`
 *      bucket so legacy callers (tab event handlers, content-script
 *      message paths) still work without a clientId.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  recordingSession,
  getRecordingSessionForClient,
  _resetRecordingSessionsForTest,
  _listRecordingSessionsForTest,
} from '@/entrypoints/background/record-replay/recording/session-manager';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import type { Flow } from '@/entrypoints/background/record-replay/types';

function emptyFlow(name: string): Flow {
  return {
    name,
    description: '',
    variables: [],
    nodes: [],
    edges: [],
    steps: [],
  } as unknown as Flow;
}

beforeEach(() => {
  _resetRecordingSessionsForTest();
});

afterEach(() => {
  _resetRecordingSessionsForTest();
});

describe('recording session per-client isolation (IMP-0165)', () => {
  it('two clients get independent RecordingSessionManager instances', async () => {
    const a = getRecordingSessionForClient('alice');
    const b = getRecordingSessionForClient('bob');
    expect(a).not.toBe(b);
  });

  it('the same clientId always resolves to the same manager (idempotent)', () => {
    const first = getRecordingSessionForClient('alice');
    const second = getRecordingSessionForClient('alice');
    expect(first).toBe(second);
  });

  it('the Proxy routes to the calling client based on request context', async () => {
    await runWithContext({ clientId: 'alice' }, async () => {
      await recordingSession.startSession(emptyFlow('alice-flow'), 100);
    });
    await runWithContext({ clientId: 'bob' }, async () => {
      await recordingSession.startSession(emptyFlow('bob-flow'), 200);
    });

    const aliceMgr = getRecordingSessionForClient('alice');
    const bobMgr = getRecordingSessionForClient('bob');
    expect(aliceMgr.getOriginTabId()).toBe(100);
    expect(bobMgr.getOriginTabId()).toBe(200);
    expect(aliceMgr.getFlow()?.name).toBe('alice-flow');
    expect(bobMgr.getFlow()?.name).toBe('bob-flow');
    // The managers are distinct object instances — that's the core
    // isolation invariant. Session-id uniqueness isn't asserted because
    // `sess_${Date.now()}` can collide within the same millisecond
    // (pre-existing weakness, out of scope for this PR).
    expect(aliceMgr).not.toBe(bobMgr);
  });

  it('client A stopping its recording does not affect client B', async () => {
    await runWithContext({ clientId: 'alice' }, async () => {
      await recordingSession.startSession(emptyFlow('a'), 1);
    });
    await runWithContext({ clientId: 'bob' }, async () => {
      await recordingSession.startSession(emptyFlow('b'), 2);
    });

    expect(getRecordingSessionForClient('alice').getStatus()).toBe('recording');
    expect(getRecordingSessionForClient('bob').getStatus()).toBe('recording');

    await runWithContext({ clientId: 'alice' }, async () => {
      recordingSession.beginStopping();
    });

    expect(getRecordingSessionForClient('alice').getStatus()).toBe('stopping');
    expect(getRecordingSessionForClient('bob').getStatus()).toBe('recording');
  });

  it('without a request context, routes to the system bucket', async () => {
    // Direct access without runWithContext — should not throw, should
    // create a system-bucket manager.
    await recordingSession.startSession(emptyFlow('system'), 42);
    const sessionsList = _listRecordingSessionsForTest();
    expect(sessionsList.some((s) => s.clientId === '__system')).toBe(true);
  });

  it('_resetRecordingSessionsForTest clears every per-client manager', async () => {
    await runWithContext({ clientId: 'alice' }, async () => {
      await recordingSession.startSession(emptyFlow('a'), 1);
    });
    await runWithContext({ clientId: 'bob' }, async () => {
      await recordingSession.startSession(emptyFlow('b'), 2);
    });
    expect(_listRecordingSessionsForTest().length).toBeGreaterThanOrEqual(2);

    _resetRecordingSessionsForTest();

    expect(_listRecordingSessionsForTest()).toEqual([]);
  });

  it('the Proxy exposes every method on RecordingSessionManager', async () => {
    // Smoke-test that common API methods are reachable through the proxy.
    // If a future refactor adds a new method to RecordingSessionManager,
    // it should be reachable via `recordingSession.<method>` automatically.
    await runWithContext({ clientId: 'alice' }, async () => {
      await recordingSession.startSession(emptyFlow('a'), 1);
      expect(typeof recordingSession.getStatus).toBe('function');
      expect(typeof recordingSession.getOriginTabId).toBe('function');
      expect(typeof recordingSession.getFlow).toBe('function');
      expect(typeof recordingSession.addActiveTab).toBe('function');
      expect(typeof recordingSession.removeActiveTab).toBe('function');
      expect(typeof recordingSession.getActiveTabs).toBe('function');
      expect(typeof recordingSession.beginStopping).toBe('function');
      expect(recordingSession.getStatus()).toBe('recording');
    });
  });
});
