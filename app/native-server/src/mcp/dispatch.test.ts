/**
 * Unit test for the bridge-side error envelope wrapper.
 *
 * The contract: every error reaching the LLM is the structured JSON envelope
 *   {"error":{"code":"...","message":"..."}}
 * Tool handlers in the extension already produce this shape via
 * `createErrorResponse`. `toErrorEnvelopeText` is the safety net for the rare
 * paths where the bridge has only a free-form error string (handleCallTool
 * threw, native-messaging timeout, etc.) — and pre-serialized envelopes pass
 * through unchanged so codes survive.
 */
import { describe, test, expect } from '@jest/globals';
import { ToolErrorCode } from 'humanchrome-shared';
import { buildFlowArgs, toErrorEnvelopeText } from './dispatch';

describe('toErrorEnvelopeText', () => {
  test('passes through a pre-serialized envelope unchanged', () => {
    const envelope = JSON.stringify({
      error: { code: ToolErrorCode.TAB_CLOSED, message: 'Tab 42 closed mid-call' },
    });
    expect(toErrorEnvelopeText(envelope)).toBe(envelope);
  });

  test('preserves details on a pre-serialized envelope', () => {
    const envelope = JSON.stringify({
      error: {
        code: ToolErrorCode.TARGET_NAVIGATED_AWAY,
        message: 'navigated',
        details: { tabId: 42, fromUrl: 'a', toUrl: 'b' },
      },
    });
    expect(toErrorEnvelopeText(envelope)).toBe(envelope);
  });

  test('wraps a free-form string with UNKNOWN code', () => {
    const out = toErrorEnvelopeText('Request timed out after 120000ms');
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe(ToolErrorCode.UNKNOWN);
    expect(parsed.error.message).toBe('Request timed out after 120000ms');
  });

  test('wraps undefined as UNKNOWN with a default message', () => {
    const out = toErrorEnvelopeText(undefined);
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe(ToolErrorCode.UNKNOWN);
    expect(typeof parsed.error.message).toBe('string');
    expect(parsed.error.message.length).toBeGreaterThan(0);
  });

  test('wraps malformed JSON as UNKNOWN, preserving the raw text', () => {
    const out = toErrorEnvelopeText('{not valid json');
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe(ToolErrorCode.UNKNOWN);
    expect(parsed.error.message).toBe('{not valid json');
  });

  test('wraps JSON without an envelope shape as UNKNOWN', () => {
    // Looks like JSON but isn't a ToolErrorEnvelope (no .error.code) — wrap it
    // so downstream parsers can rely on the shape.
    const out = toErrorEnvelopeText(JSON.stringify({ foo: 'bar' }));
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe(ToolErrorCode.UNKNOWN);
    expect(parsed.error.message).toBe('{"foo":"bar"}');
  });
});

describe('buildFlowArgs (IMP-0024 — runner options must flow to the top level)', () => {
  test('hoists every flow-runner option to the top level and leaves only user vars in args', () => {
    const out = buildFlowArgs('flow_abc', {
      // runner options
      tabTarget: 'new',
      refresh: true,
      captureNetwork: true,
      returnLogs: true,
      timeoutMs: 30_000,
      startUrl: 'https://example.com',
      // user-defined flow variables
      query: 'hello',
      max: 5,
    });
    expect(out).toEqual({
      flowId: 'flow_abc',
      args: { query: 'hello', max: 5 },
      tabTarget: 'new',
      refresh: true,
      captureNetwork: true,
      returnLogs: true,
      timeoutMs: 30_000,
      startUrl: 'https://example.com',
    });
  });

  test('returns an empty vars bag when only runner options were supplied', () => {
    const out = buildFlowArgs('flow_only_opts', { tabTarget: 'current', timeoutMs: 1000 });
    expect(out.args).toEqual({});
    expect(out.tabTarget).toBe('current');
    expect(out.timeoutMs).toBe(1000);
  });

  test('keeps args identical to user vars when no runner options are supplied', () => {
    const out = buildFlowArgs('flow_vars_only', { query: 'q', limit: 10 });
    expect(out.args).toEqual({ query: 'q', limit: 10 });
    expect(out.tabTarget).toBeUndefined();
    expect(out.refresh).toBeUndefined();
    expect(out.captureNetwork).toBeUndefined();
    expect(out.returnLogs).toBeUndefined();
    expect(out.timeoutMs).toBeUndefined();
    expect(out.startUrl).toBeUndefined();
  });

  test('tolerates undefined / null mcpArgs', () => {
    expect(buildFlowArgs('f', undefined)).toEqual({
      flowId: 'f',
      args: {},
      tabTarget: undefined,
      refresh: undefined,
      captureNetwork: undefined,
      returnLogs: undefined,
      timeoutMs: undefined,
      startUrl: undefined,
    });
    expect(buildFlowArgs('f', null)).toEqual({
      flowId: 'f',
      args: {},
      tabTarget: undefined,
      refresh: undefined,
      captureNetwork: undefined,
      returnLogs: undefined,
      timeoutMs: undefined,
      startUrl: undefined,
    });
  });
});
