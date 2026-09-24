import { describe, expect, test } from '@jest/globals';
import { FleetLeases } from './leases';

describe('FleetLeases', () => {
  test('stickily assigns pooled profiles and moves to the next free profile', () => {
    const leases = new FleetLeases(900, () => 0);
    expect(leases.acquireFromPool('agent-a', 'google', ['p01', 'p02'])).toBe('p01');
    expect(leases.acquireFromPool('agent-a', 'google', ['p01', 'p02'])).toBe('p01');
    expect(leases.acquireFromPool('agent-b', 'google', ['p01', 'p02'])).toBe('p02');
  });

  test('returns null when the pool is exhausted', () => {
    const leases = new FleetLeases(900, () => 0);
    leases.acquireFromPool('a', 'any', ['p01']);
    expect(leases.acquireFromPool('b', 'any', ['p01'])).toBeNull();
  });

  test('explicit acquisition reports the current holder', () => {
    const leases = new FleetLeases(900, () => 0);
    leases.acquire('a', 'p01');
    expect(leases.acquire('b', 'p01')).toEqual({ ok: false, heldBy: 'a' });
  });

  test('expired leases become acquirable after the idle TTL', () => {
    let now = 0;
    const leases = new FleetLeases(10, () => now);
    leases.acquire('a', 'p01');
    now = 10_001;
    expect(leases.acquire('b', 'p01')).toEqual({ ok: true });
  });

  test('release frees every profile held by an agent', () => {
    const leases = new FleetLeases(900, () => 0);
    leases.acquire('a', 'p01');
    leases.acquire('a', 'p02');
    leases.acquire('b', 'p03');
    expect(leases.release('a')).toEqual(['p01', 'p02']);
    expect(leases.acquire('b', 'p01')).toEqual({ ok: true });
  });
});
