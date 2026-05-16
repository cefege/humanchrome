import { describe, it, expect } from '@jest/globals';
import { normalizeSessionName } from './session-name';

describe('normalizeSessionName', () => {
  it('returns the trimmed lowercased value for a plain name', () => {
    expect(normalizeSessionName('  AcmeAPI  ')).toBe('acmeapi');
  });

  it('replaces whitespace, slashes, and colons with `-`', () => {
    expect(normalizeSessionName('foo bar/baz\\qux:zap')).toBe('foo-bar-baz-qux-zap');
  });

  it('strips characters outside `[a-z0-9_.-]`', () => {
    expect(normalizeSessionName('hello@world!')).toBe('helloworld');
  });

  it('collapses repeated `-`, `_`, `.` runs', () => {
    expect(normalizeSessionName('foo---bar___baz...qux')).toBe('foo-bar_baz.qux');
  });

  it('trims leading/trailing `-_.`', () => {
    expect(normalizeSessionName('.--foo--.')).toBe('foo');
  });

  it('NFC-normalizes composed/decomposed forms to the same key', () => {
    const composed = normalizeSessionName('café');
    const decomposed = normalizeSessionName('café');
    expect(composed).toBe(decomposed);
  });

  it('caps length at 64', () => {
    const long = 'a'.repeat(100);
    const result = normalizeSessionName(long);
    expect(result?.length).toBeLessThanOrEqual(64);
  });

  it('returns null for empty / whitespace / non-string input', () => {
    expect(normalizeSessionName('')).toBeNull();
    expect(normalizeSessionName('   ')).toBeNull();
    expect(normalizeSessionName(null as unknown as string)).toBeNull();
    expect(normalizeSessionName(undefined as unknown as string)).toBeNull();
    expect(normalizeSessionName(42 as unknown as string)).toBeNull();
  });

  it('rejects names that start with `__` (reserved for synthetic UI ids)', () => {
    expect(normalizeSessionName('__ui:popup')).toBeNull();
    expect(normalizeSessionName('__foo')).toBeNull();
  });

  it('rejects reserved names: default, null, undefined', () => {
    expect(normalizeSessionName('default')).toBeNull();
    expect(normalizeSessionName('NULL')).toBeNull();
    expect(normalizeSessionName('undefined')).toBeNull();
  });

  it('rejects input that normalizes to empty', () => {
    expect(normalizeSessionName('!@#$%^&*()')).toBeNull();
  });
});
