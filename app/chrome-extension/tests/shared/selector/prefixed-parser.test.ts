/**
 * Prefixed-selector parser tests (IMP-0098).
 *
 * Covers the formats documented in the IMP sketch:
 *   role:button[name="Submit",exact=true]
 *   label:Email
 *   placeholder:Search
 *   alt:Logo
 *   title:Close
 *   testid:submit-btn
 *   text:Login
 *   css:body > foo
 *   xpath://button
 *   iframe |> role:button[name="Pay"]  (composite — passthrough as CSS)
 */

import { describe, it, expect } from 'vitest';
import { parsePrefixedSelector } from '@/shared/selector/prefixed-parser';

describe('parsePrefixedSelector', () => {
  it('parses role with name + exact', () => {
    const p = parsePrefixedSelector('role:button[name="Submit",exact=true]');
    expect(p.kind).toBe('role');
    expect(p.role).toBe('button');
    expect(p.name).toBe('Submit');
    expect(p.exact).toBe(true);
  });

  it('parses bare role', () => {
    const p = parsePrefixedSelector('role:link');
    expect(p.kind).toBe('role');
    expect(p.role).toBe('link');
    expect(p.name).toBeUndefined();
  });

  it('parses label', () => {
    const p = parsePrefixedSelector('label:Email');
    expect(p.kind).toBe('label');
    expect(p.value).toBe('Email');
  });

  it('parses placeholder', () => {
    const p = parsePrefixedSelector('placeholder:Search');
    expect(p.kind).toBe('placeholder');
  });

  it('parses alt', () => {
    const p = parsePrefixedSelector('alt:Logo');
    expect(p.kind).toBe('alt');
  });

  it('parses title', () => {
    const p = parsePrefixedSelector('title:Close');
    expect(p.kind).toBe('title');
  });

  it('parses testid', () => {
    const p = parsePrefixedSelector('testid:submit-btn');
    expect(p.kind).toBe('testid');
    expect(p.value).toBe('submit-btn');
  });

  it('parses text with @exact shorthand', () => {
    const p = parsePrefixedSelector('text:Hello@exact');
    expect(p.kind).toBe('text');
    expect(p.value).toBe('Hello');
    expect(p.exact).toBe(true);
  });

  it('parses xpath prefix', () => {
    const p = parsePrefixedSelector('xpath://button[1]');
    expect(p.kind).toBe('xpath');
    expect(p.value).toBe('//button[1]');
  });

  it('parses css prefix explicitly', () => {
    const p = parsePrefixedSelector('css:body > .foo');
    expect(p.kind).toBe('css');
    expect(p.value).toBe('body > .foo');
  });

  it('falls back to CSS when no known prefix matches', () => {
    const p = parsePrefixedSelector('body > div');
    expect(p.kind).toBe('css');
    expect(p.value).toBe('body > div');
  });

  it('composite selector stays as CSS so the locator can split it', () => {
    const p = parsePrefixedSelector('iframe#x |> role:button[name="Y"]');
    expect(p.kind).toBe('css');
    expect(p.value).toContain('|>');
  });

  it('unknown prefix falls back to CSS (graceful)', () => {
    const p = parsePrefixedSelector('foo:bar');
    expect(p.kind).toBe('css');
  });
});
