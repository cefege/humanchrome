/**
 * Tool-layer NOT_ACTIONABLE classification + `force` bypass for
 * chrome_click_element and chrome_fill_or_select (IMP-0097).
 *
 * The inject-scripts return `{notActionable: true, failures: [...]}` and
 * the tool's job is to map that into a structured `NOT_ACTIONABLE`
 * envelope so callers can branch on `error.code` and inspect
 * `error.details.failures`. We assert both the classification and that
 * `force: true` flows through to the inject-script so callers can opt
 * out of the suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clickTool, fillTool } from '@/entrypoints/background/tools/browser/interaction';

let sendMessageMock: ReturnType<typeof vi.fn>;
let executeScriptMock: ReturnType<typeof vi.fn>;
let queryMock: ReturnType<typeof vi.fn>;
let getTabMock: ReturnType<typeof vi.fn>;
let webNavGetFrameMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Default: tab 7 exists, no main-frame info (forces fall-through to
  // chrome.tabs.get), and the content-script ping returns pong so
  // injectContentScript skips the actual script eval.
  sendMessageMock = vi.fn(async (_tabId, msg) => {
    if (msg?.action?.endsWith?.('_ping')) return { status: 'pong' };
    // tests override per-call below
    return { success: true };
  });
  executeScriptMock = vi.fn().mockResolvedValue([{ result: undefined }]);
  queryMock = vi.fn().mockResolvedValue([{ id: 7, url: 'https://example.com' }]);
  getTabMock = vi.fn().mockResolvedValue({ id: 7, url: 'https://example.com' });
  webNavGetFrameMock = vi.fn().mockResolvedValue({ url: 'https://example.com', documentId: 'd1' });

  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    query: queryMock,
    get: getTabMock,
    sendMessage: sendMessageMock,
  };

  (globalThis.chrome as any).scripting = { executeScript: executeScriptMock };

  (globalThis.chrome as any).webNavigation = {
    ...(globalThis.chrome as any).webNavigation,
    getFrame: webNavGetFrameMock,
  };
});

afterEach(() => {
  // chrome.* stays so other tests don't trip
});

function parseEnvelope(res: { content: Array<{ text: string }>; isError: boolean }): {
  error: { code: string; message: string; details?: Record<string, unknown> };
} {
  return JSON.parse(res.content[0].text);
}

describe('chrome_click_element: NOT_ACTIONABLE classification', () => {
  it('classifies a notActionable inject-script response as NOT_ACTIONABLE', async () => {
    sendMessageMock.mockImplementation(async (_tabId, msg) => {
      if (msg?.action?.endsWith?.('_ping')) return { status: 'pong' };
      // Click-helper return path
      return {
        error: 'Element is not actionable: occluded_by:div#cookie-banner',
        notActionable: true,
        failures: ['occluded_by:div#cookie-banner'],
        method: 'ref',
        ref: 'r-1',
      };
    });

    const res = await clickTool.execute({ ref: 'r-1', tabId: 7 });
    expect(res.isError).toBe(true);
    const env = parseEnvelope(res as any);
    expect(env.error.code).toBe('NOT_ACTIONABLE');
    expect(env.error.message).toContain('occluded_by:div#cookie-banner');
    expect(env.error.details?.failures).toEqual(['occluded_by:div#cookie-banner']);
  });

  it('passes through force:true to the inject-script', async () => {
    sendMessageMock.mockImplementation(async (_tabId, msg) => {
      if (msg?.action?.endsWith?.('_ping')) return { status: 'pong' };
      return { success: true, message: 'ok', elementInfo: { tagName: 'BUTTON' } };
    });

    await clickTool.execute({
      ref: 'r-1',
      tabId: 7,
      force: true,
      actionabilityTimeoutMs: 8000,
    });

    const call = sendMessageMock.mock.calls.find(([_id, msg]) => msg?.action === 'clickElement');
    expect(call).toBeDefined();
    if (call) {
      expect(call[1].force).toBe(true);
      expect(call[1].actionabilityTimeoutMs).toBe(8000);
    }
  });

  it('defaults force to false and actionabilityTimeoutMs to undefined (helper applies the default)', async () => {
    sendMessageMock.mockImplementation(async (_tabId, msg) => {
      if (msg?.action?.endsWith?.('_ping')) return { status: 'pong' };
      return { success: true, message: 'ok', elementInfo: { tagName: 'BUTTON' } };
    });
    await clickTool.execute({ ref: 'r-1', tabId: 7 });
    const call = sendMessageMock.mock.calls.find(([_id, msg]) => msg?.action === 'clickElement');
    expect(call).toBeDefined();
    if (call) {
      expect(call[1].force).toBe(false);
      expect(call[1].actionabilityTimeoutMs).toBeUndefined();
    }
  });

  it('injects actionability.js alongside click-helper.js', async () => {
    // Tool-name ping returns falsy so executeScript runs (otherwise the
    // optimistic ping-skip path hides files[]); actionability_ping returns
    // pong so the IMP-0137 assertHelperPresent self-test doesn't fire.
    sendMessageMock.mockImplementation(async (_tabId, msg) => {
      if (msg?.action === 'actionability_ping') return { status: 'pong' };
      if (msg?.action?.endsWith?.('_ping')) return undefined;
      return { success: true, message: 'ok', elementInfo: { tagName: 'BUTTON' } };
    });
    await clickTool.execute({ ref: 'r-1', tabId: 7 });
    const injectCall = executeScriptMock.mock.calls.find((args) => {
      const [arg] = args;
      return Array.isArray(arg?.files);
    });
    expect(injectCall).toBeDefined();
    if (injectCall) {
      const files = injectCall[0].files as string[];
      expect(files).toContain('inject-scripts/actionability.js');
      expect(files).toContain('inject-scripts/click-helper.js');
    }
  });
});

describe('chrome_fill_or_select: NOT_ACTIONABLE classification', () => {
  it('classifies a notActionable inject-script response as NOT_ACTIONABLE', async () => {
    sendMessageMock.mockImplementation(async (_tabId, msg) => {
      if (msg?.action?.endsWith?.('_ping')) return { status: 'pong' };
      return {
        error: 'Element is not actionable: disabled',
        notActionable: true,
        failures: ['disabled'],
        elementInfo: { tagName: 'INPUT' },
      };
    });
    const res = await fillTool.execute({ ref: 'r-1', value: 'x', tabId: 7 });
    expect(res.isError).toBe(true);
    const env = parseEnvelope(res as any);
    expect(env.error.code).toBe('NOT_ACTIONABLE');
    expect(env.error.message).toContain('disabled');
    expect(env.error.details?.failures).toEqual(['disabled']);
  });

  it('passes through force:true and actionabilityTimeoutMs to the inject-script', async () => {
    sendMessageMock.mockImplementation(async (_tabId, msg) => {
      if (msg?.action?.endsWith?.('_ping')) return { status: 'pong' };
      return { success: true, message: 'ok', elementInfo: { tagName: 'INPUT' } };
    });
    await fillTool.execute({
      ref: 'r-1',
      value: 'hello',
      tabId: 7,
      force: true,
      actionabilityTimeoutMs: 9000,
    });
    const call = sendMessageMock.mock.calls.find(([_id, msg]) => msg?.action === 'fillElement');
    expect(call).toBeDefined();
    if (call) {
      expect(call[1].force).toBe(true);
      expect(call[1].actionabilityTimeoutMs).toBe(9000);
    }
  });

  it('injects actionability.js alongside fill-helper.js', async () => {
    // Same pattern as the click case above — actionability_ping returns
    // pong so the IMP-0137 self-test doesn't fire, but the fill-helper
    // ping returns falsy so executeScript actually runs.
    sendMessageMock.mockImplementation(async (_tabId, msg) => {
      if (msg?.action === 'actionability_ping') return { status: 'pong' };
      if (msg?.action?.endsWith?.('_ping')) return undefined;
      return { success: true, message: 'ok', elementInfo: { tagName: 'INPUT' } };
    });
    await fillTool.execute({ ref: 'r-1', value: 'hello', tabId: 7 });
    const injectCall = executeScriptMock.mock.calls.find((args) => {
      const [arg] = args;
      return Array.isArray(arg?.files);
    });
    expect(injectCall).toBeDefined();
    if (injectCall) {
      const files = injectCall[0].files as string[];
      expect(files).toContain('inject-scripts/actionability.js');
      expect(files).toContain('inject-scripts/fill-helper.js');
    }
  });
});
