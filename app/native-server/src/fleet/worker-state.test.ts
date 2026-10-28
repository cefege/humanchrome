import { afterEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkerState, WorkerStateError, type WorkerLeaseIdentity } from './worker-state';

const first: WorkerLeaseIdentity = {
  agent: 'client-a:agent-a',
  leaseId: '11111111-1111-4111-8111-111111111111',
  generation: 1,
};
const next: WorkerLeaseIdentity = {
  agent: 'client-b:agent-b',
  leaseId: '22222222-2222-4222-8222-222222222222',
  generation: 2,
};

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WorkerState durable fences', () => {
  test('preserves a live lease and rejects stale/released identities after restart', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'hc-worker-state-'));
    tempRoots.push(root);
    const file = path.join(root, 'fences.sqlite');
    const firstState = new WorkerState(file, () => 1_000);
    firstState.claim('browser', first, 30);
    firstState.close();

    const restarted = new WorkerState(file, () => 2_000);
    expect(restarted.leasedBy('browser')).toBe(first.agent);
    expect(() => restarted.claim('browser', { ...first, generation: 0 }, 30)).toThrow(
      WorkerStateError,
    );
    restarted.release('browser', first);
    expect(() => restarted.claim('browser', first, 30)).toThrow(WorkerStateError);
    restarted.close();
  });

  test('expired lease cannot revive at its generation and replacement advances its fence', () => {
    let now = 1_000;
    const state = new WorkerState(':memory:', () => now);
    state.claim('browser', first, 15);
    now += 15_001;
    expect(() => state.claim('browser', first, 15)).toThrow(/cannot be revived/);
    expect(state.claim('browser', next, 15).generation).toBe(2);
    state.close();
  });

  test('closing a read-only stream releases its in-memory guard without quarantine', () => {
    const state = new WorkerState(':memory:', () => 1_000);
    state.claim('browser', first, 15);
    const read = state.beginRead('browser', first);
    expect(state.hasActiveWork()).toBe(true);
    expect(() => state.release('browser', first)).toThrow(/active request/);
    read.clientClosed();
    state.release('browser', first);
    expect(state.hasActiveWork()).toBe(false);
    state.close();
  });

  test('an unresolved execution blocks release and reassignment across restart', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'hc-worker-state-'));
    tempRoots.push(root);
    const file = path.join(root, 'fences.sqlite');
    const live = new WorkerState(file, () => 1_000);
    live.claim('browser', first, 30);
    const execution = live.beginExecution('browser', first);
    execution.clientClosed();
    expect(() => live.release('browser', first)).toThrow(/active request/);
    live.close();

    const restarted = new WorkerState(file, () => 2_000);
    expect(restarted.hasActiveWork()).toBe(true);
    expect(() => restarted.claim('browser', next, 30)).toThrow(/active operation/);
    expect(() => restarted.release('browser', first)).toThrow(/active request/);
    const done = restarted.beginTransition('browser', first, true);
    restarted.clearUncertainAfterRestart('browser', first);
    done();
    expect(restarted.hasActiveWork()).toBe(false);
    restarted.close();
  });

  test('explicit recovery only clears uncertainty after the owning lease expired', () => {
    let now = 1_000;
    const state = new WorkerState(':memory:', () => now);
    state.claim('browser', first, 15);
    state.beginExecution('browser', first).clientClosed();
    expect(() => state.beginRecovery('browser')).toThrow(/live lease/);
    now += 15_001;
    const done = state.beginRecovery('browser');
    state.clearUncertainAfterRecovery('browser');
    done();
    expect(state.hasActiveWork()).toBe(false);
    state.close();
  });
});
