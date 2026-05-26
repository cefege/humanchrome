import { describe, it, expect } from 'vitest';
import { enforceOutputBudget, DEFAULT_OUTPUT_BUDGET_BYTES } from './output-budget';

function makeText(bytes: number): string {
  return 'x'.repeat(bytes);
}

describe('enforceOutputBudget', () => {
  it('passes through small text results unchanged', () => {
    const result = { content: [{ type: 'text', text: 'small payload' }], isError: false };
    const out = enforceOutputBudget(result);
    expect(out).toBe(result);
    expect(out.content[0].text).toBe('small payload');
  });

  it('truncates oversized single-text-block results', () => {
    const big = makeText(50_000);
    const result = { content: [{ type: 'text', text: big }], isError: false };
    const out: any = enforceOutputBudget(result);
    expect(out).not.toBe(result);
    expect(out.truncation.truncated).toBe(true);
    expect(out.truncation.originalSize).toBe(50_000);
    expect(out.truncation.limit).toBe(DEFAULT_OUTPUT_BUDGET_BYTES);
    expect(out.truncation.unit).toBe('bytes');
    expect(out.truncation.hint).toContain('raw=true');
    expect(out.content[0].text.length).toBeLessThan(big.length);
    expect(out.content[0].text).toContain('[Result truncated by dispatcher');
  });

  it('respects a custom budgetBytes override', () => {
    const big = makeText(50_000);
    const result = { content: [{ type: 'text', text: big }], isError: false };
    const out: any = enforceOutputBudget(result, { budgetBytes: 4096 });
    expect(out.truncation.limit).toBe(4096);
    expect(out.content[0].text.length).toBeLessThan(5000);
  });

  it('bypasses entirely when raw=true', () => {
    const big = makeText(50_000);
    const result = { content: [{ type: 'text', text: big }], isError: false };
    const out = enforceOutputBudget(result, { raw: true });
    expect(out).toBe(result);
  });

  it('never truncates error results', () => {
    const big = makeText(50_000);
    const result = { content: [{ type: 'text', text: big }], isError: true };
    const out = enforceOutputBudget(result);
    expect(out).toBe(result);
  });

  it('passes through pure image content', () => {
    const result = {
      content: [{ type: 'image', data: 'base64-blob', mimeType: 'image/png' }],
      isError: false,
    };
    const out = enforceOutputBudget(result);
    expect(out).toBe(result);
  });

  it('preserves image blocks and caps text blocks in mixed content', () => {
    const big = makeText(50_000);
    const result = {
      content: [
        { type: 'text', text: big },
        { type: 'image', data: 'base64-blob', mimeType: 'image/png' },
      ],
      isError: false,
    };
    const out: any = enforceOutputBudget(result);
    expect(out.content[1]).toEqual({
      type: 'image',
      data: 'base64-blob',
      mimeType: 'image/png',
    });
    expect(out.content[0].text.length).toBeLessThan(big.length);
    expect(out.truncation.truncated).toBe(true);
  });

  it('clamps absurdly small budgets to a 1 KiB floor', () => {
    const big = makeText(50_000);
    const result = { content: [{ type: 'text', text: big }], isError: false };
    const out: any = enforceOutputBudget(result, { budgetBytes: 1 });
    expect(out.truncation.limit).toBe(1024);
  });

  it('returns input unchanged when result is not an object', () => {
    expect(enforceOutputBudget(null as any)).toBeNull();
    expect(enforceOutputBudget(undefined as any)).toBeUndefined();
  });

  it('returns input unchanged when content is missing or non-array', () => {
    const r1: any = { isError: false };
    const r2: any = { content: 'not-an-array', isError: false };
    expect(enforceOutputBudget(r1)).toBe(r1);
    expect(enforceOutputBudget(r2)).toBe(r2);
  });

  it('counts UTF-8 bytes, not JS code units', () => {
    // 10,000 multi-byte characters → 30,000 bytes (each '✓' is 3 bytes UTF-8).
    const multibyte = '✓'.repeat(10_000);
    const result = { content: [{ type: 'text', text: multibyte }], isError: false };
    const out: any = enforceOutputBudget(result);
    expect(out.truncation.originalSize).toBe(30_000);
    expect(out.truncation.truncated).toBe(true);
  });
});
