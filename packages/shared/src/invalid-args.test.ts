import { describe, it, expect } from 'vitest';
import {
  buildInvalidArgsDetails,
  didYouMean,
  invalidArgsEnumDetails,
  truncateReceived,
} from './invalid-args';

describe('didYouMean', () => {
  it('returns the exact match when received equals a candidate', () => {
    expect(didYouMean('start', ['start', 'stop'])).toBe('start');
  });

  it('returns the close case-insensitive match', () => {
    expect(didYouMean('Start', ['start', 'stop'])).toBe('start');
  });

  it('returns the single-edit suggestion', () => {
    expect(didYouMean('strat', ['start', 'stop', 'flush', 'status'])).toBe('start');
  });

  it('returns null when no candidate is within maxDistance', () => {
    expect(didYouMean('xyz', ['start', 'stop'])).toBeNull();
  });

  it('returns null for non-string received', () => {
    expect(didYouMean(123, ['start', 'stop'])).toBeNull();
    expect(didYouMean(undefined, ['start', 'stop'])).toBeNull();
    expect(didYouMean(null, ['start', 'stop'])).toBeNull();
  });

  it('returns null for empty candidate list', () => {
    expect(didYouMean('start', [])).toBeNull();
  });

  it('honors maxDistance bound', () => {
    expect(didYouMean('startup', ['stop'], 1)).toBeNull();
    expect(didYouMean('startup', ['startups'], 1)).toBe('startups');
  });
});

describe('truncateReceived', () => {
  it('passes through short strings', () => {
    expect(truncateReceived('short')).toBe('short');
  });

  it('truncates long strings', () => {
    const long = 'x'.repeat(500);
    const out = truncateReceived(long);
    expect(typeof out).toBe('string');
    expect((out as string).length).toBeLessThan(long.length);
    expect((out as string).endsWith('…')).toBe(true);
  });

  it('preserves primitives', () => {
    expect(truncateReceived(123)).toBe(123);
    expect(truncateReceived(true)).toBe(true);
    expect(truncateReceived(null)).toBe(null);
    expect(truncateReceived(undefined)).toBe(undefined);
  });

  it('json-stringifies objects and truncates', () => {
    expect(truncateReceived({ a: 1 })).toBe('{"a":1}');
    const big = { data: 'x'.repeat(500) };
    const out = truncateReceived(big);
    expect((out as string).endsWith('…')).toBe(true);
  });
});

describe('buildInvalidArgsDetails', () => {
  it('always sets `arg`', () => {
    expect(buildInvalidArgsDetails({ arg: 'foo' })).toEqual({ arg: 'foo' });
  });

  it('includes `received` when provided', () => {
    expect(buildInvalidArgsDetails({ arg: 'foo', received: 'bar' })).toEqual({
      arg: 'foo',
      received: 'bar',
    });
  });

  it('infers `expected: { enum: [...] }` from candidates', () => {
    const d = buildInvalidArgsDetails({
      arg: 'action',
      received: 'xyz',
      candidates: ['start', 'stop'],
    });
    expect(d.expected).toEqual({ enum: ['start', 'stop'] });
  });

  it('auto-generates a "did you mean" hint from candidates', () => {
    const d = buildInvalidArgsDetails({
      arg: 'action',
      received: 'strat',
      candidates: ['start', 'stop', 'flush'],
    });
    expect(d.hint).toBe('Did you mean "start"?');
  });

  it('omits hint when no candidate is close enough', () => {
    const d = buildInvalidArgsDetails({
      arg: 'action',
      received: 'completely-unrelated-thing',
      candidates: ['start', 'stop'],
    });
    expect(d.hint).toBeUndefined();
  });

  it('explicit `hint` wins over auto-generated', () => {
    const d = buildInvalidArgsDetails({
      arg: 'action',
      received: 'strat',
      candidates: ['start', 'stop'],
      hint: 'use action="start"',
    });
    expect(d.hint).toBe('use action="start"');
  });

  it('explicit `expected` wins over inferred', () => {
    const d = buildInvalidArgsDetails({
      arg: 'count',
      received: -1,
      expected: { type: 'integer', minimum: 0 },
      candidates: ['ignored'],
    });
    expect(d.expected).toEqual({ type: 'integer', minimum: 0 });
  });

  it('merges `extra` fields', () => {
    const d = buildInvalidArgsDetails({
      arg: 'selector',
      received: '.foo',
      extra: { matchCount: 3, samples: ['#a', '#b'] },
    });
    expect(d.matchCount).toBe(3);
    expect(d.samples).toEqual(['#a', '#b']);
  });

  it('truncates received', () => {
    const d = buildInvalidArgsDetails({
      arg: 'value',
      received: 'x'.repeat(500),
    });
    expect((d.received as string).endsWith('…')).toBe(true);
  });
});

describe('invalidArgsEnumDetails', () => {
  it('is shorthand for the enum case', () => {
    const d = invalidArgsEnumDetails('action', 'strat', ['start', 'stop']);
    expect(d).toEqual({
      arg: 'action',
      received: 'strat',
      expected: { enum: ['start', 'stop'] },
      hint: 'Did you mean "start"?',
    });
  });

  it('passes extras through', () => {
    const d = invalidArgsEnumDetails('action', 'strat', ['start'], { context: 'sessions' });
    expect(d.context).toBe('sessions');
  });
});
