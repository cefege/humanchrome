/**
 * classifyTabError tests (IMP-0132).
 *
 * Pins the regex priority + ctx-merge behavior so the 16+ tool catches
 * that delegate to this helper can't drift.
 */
import { describe, expect, it } from 'vitest';
import { ToolError, ToolErrorCode } from 'humanchrome-shared';

import { classifyTabError } from '@/common/tool-handler';

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('classifyTabError', () => {
  it('classifies "No tab with id" as TAB_CLOSED and rewrites the message when tabId is supplied', () => {
    const res = classifyTabError(new Error('No tab with id: 42'), {
      toolName: 'chrome_focus',
      tabId: 42,
    });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.code).toBe('TAB_CLOSED');
    expect(body.error.message).toBe('Tab 42 not found');
    expect(body.error.details.tabId).toBe(42);
    expect(body.error.details.toolName).toBe('chrome_focus');
  });

  it('classifies "No tab with id" as TAB_CLOSED and preserves the original message when tabId is absent', () => {
    const res = classifyTabError(new Error('No tab with id: 9'));
    const body = parseBody(res);
    expect(body.error.code).toBe('TAB_CLOSED');
    expect(body.error.message).toBe('No tab with id: 9');
  });

  it('classifies "Receiving end does not exist" as TAB_CLOSED', () => {
    const res = classifyTabError(new Error('Receiving end does not exist.'), {
      tabId: 7,
    });
    const body = parseBody(res);
    expect(body.error.code).toBe('TAB_CLOSED');
    expect(body.error.message).toContain('Receiving end');
  });

  it('classifies "Could not establish connection" as TAB_CLOSED', () => {
    const res = classifyTabError(new Error('Could not establish connection. Receiving end…'), {});
    const body = parseBody(res);
    expect(body.error.code).toBe('TAB_CLOSED');
  });

  it('falls back to UNKNOWN with the original message for unrelated errors', () => {
    const res = classifyTabError(new Error('CDP attach failed'), {
      toolName: 'chrome_intercept_response',
      tabId: 12,
    });
    const body = parseBody(res);
    expect(body.error.code).toBe('UNKNOWN');
    expect(body.error.message).toBe('CDP attach failed');
    expect(body.error.details.tabId).toBe(12);
    expect(body.error.details.toolName).toBe('chrome_intercept_response');
  });

  it('preserves a ToolError code + details and merges ctx into details (ctx wins on conflict)', () => {
    const original = new ToolError(ToolErrorCode.TAB_NOT_OWNED, 'owned by client X', {
      tabId: 99,
      owner: 'X',
    });
    const res = classifyTabError(original, {
      toolName: 'chrome_focus',
      tabId: 42,
      extraDetails: { frameId: 3 },
    });
    const body = parseBody(res);
    expect(body.error.code).toBe('TAB_NOT_OWNED');
    expect(body.error.message).toBe('owned by client X');
    // ctx.tabId overrides ToolError's tabId (caller's intent wins)
    expect(body.error.details.tabId).toBe(42);
    expect(body.error.details.owner).toBe('X');
    expect(body.error.details.frameId).toBe(3);
    expect(body.error.details.toolName).toBe('chrome_focus');
  });

  it('handles non-Error throws (strings, plain values)', () => {
    const res = classifyTabError('something bad', {});
    const body = parseBody(res);
    expect(body.error.code).toBe('UNKNOWN');
    expect(body.error.message).toBe('something bad');
  });
});
