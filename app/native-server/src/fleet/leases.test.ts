import { describe, expect, test } from '@jest/globals';
import { FleetLeases } from './leases';

/** A clock the test owns: every liveness decision in this file is about time. */
function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

describe('FleetLeases', () => {
  test('stickily assigns pooled profiles and moves to the next free profile', () => {
    const leases = new FleetLeases(900, () => 0);
    expect(leases.acquireFromPool('agent-a', ['p01', 'p02'])).toBe('p01');
    expect(leases.acquireFromPool('agent-a', ['p01', 'p02'])).toBe('p01');
    expect(leases.acquireFromPool('agent-b', ['p01', 'p02'])).toBe('p02');
  });

  test('returns null when the pool is exhausted', () => {
    const leases = new FleetLeases(900, () => 0);
    leases.acquireFromPool('a', ['p01']);
    expect(leases.acquireFromPool('b', ['p01'])).toBeNull();
  });

  test('explicit acquisition reports the current holder', () => {
    const leases = new FleetLeases(900, () => 0);
    leases.acquire('a', 'p01');
    expect(leases.acquire('b', 'p01')).toEqual({ ok: false, heldBy: 'a' });
  });

  test('a live lease is renewed in place with no displacement', () => {
    const leases = new FleetLeases(900, () => 0);
    expect(leases.acquire('a', 'p01')).toEqual({ ok: true, displaced: null });
  });

  test('an expired lease is taken over and names the agent it displaced', () => {
    const time = clock();
    const leases = new FleetLeases(10, time.now);
    leases.acquire('a', 'p01');
    time.advance(10_001);
    expect(leases.acquire('b', 'p01')).toEqual({ ok: true, displaced: 'a' });
    expect(leases.list()).toEqual([{ agent: 'b', profile: 'p01', lastSeen: 10_001 }]);
  });

  test('a lease is live up to the TTL and expired one tick past it', () => {
    const time = clock();
    const leases = new FleetLeases(10, time.now);
    leases.acquire('a', 'p01');
    time.advance(9_999);
    expect(leases.acquire('b', 'p01')).toEqual({ ok: false, heldBy: 'a' });
  });

  test('touch only refreshes the holder, never a stranger', () => {
    const time = clock();
    const leases = new FleetLeases(10, time.now);
    leases.acquire('a', 'p01');
    time.advance(9_000);
    // A stranger's touch must not extend the lease: only the holder's own
    // activity says the browser is still in use.
    leases.touch('b', 'p01');
    time.advance(500);
    expect(leases.acquire('b', 'p01')).toEqual({ ok: false, heldBy: 'a' });
    leases.touch('a', 'p01');
    time.advance(500);
    expect(leases.acquire('b', 'p01')).toEqual({ ok: false, heldBy: 'a' });
  });

  test('sweep returns and forgets exactly the expired leases', () => {
    const time = clock();
    const leases = new FleetLeases(10, time.now);
    leases.acquire('a', 'p01');
    leases.acquire('a', 'p02');
    time.advance(1_000);
    leases.acquire('b', 'p03');
    time.advance(9_500);
    expect(leases.sweep().map((lease) => lease.profile)).toEqual(['p01', 'p02']);
    expect(leases.list().map((lease) => lease.profile)).toEqual(['p03']);
    expect(leases.sweep()).toEqual([]);
  });

  test('a pool acquisition reuses a live lease and takes over an expired one', () => {
    const time = clock();
    const leases = new FleetLeases(10, time.now);
    leases.acquire('a', 'p01');
    time.advance(5_000);
    leases.acquireFromPool('b', ['p01', 'p02']);
    // p01 is still live and held, so b lands on the free p02.
    expect(leases.list().map((lease) => lease.agent)).toEqual(['a', 'b']);
    time.advance(6_000);
    expect(leases.acquireFromPool('b', ['p01'])).toBe('p01');
  });

  test('release frees every profile held by an agent', () => {
    const leases = new FleetLeases(900, () => 0);
    leases.acquire('a', 'p01');
    leases.acquire('a', 'p02');
    leases.acquire('b', 'p03');
    expect(leases.release('a')).toEqual(['p01', 'p02']);
    expect(leases.acquire('b', 'p01')).toEqual({ ok: true, displaced: null });
  });

  test('list is sorted by profile and returns copies', () => {
    const leases = new FleetLeases(900, () => 0);
    leases.acquire('a', 'p02');
    leases.acquire('a', 'p01');
    const listed = leases.list();
    expect(listed.map((lease) => lease.profile)).toEqual(['p01', 'p02']);
    listed[0]!.agent = 'mutated';
    expect(leases.list()[0]!.agent).toBe('a');
  });
});
