/**
 * chrome_await_element tests.
 *
 * Tool injects `inject-scripts/wait-helper.js` via chrome.scripting.executeScript,
 * then sends a `waitForElement` IPC to the content-script and returns the
 * shaped response. Tests stub both chrome APIs and assert the envelope
 * contract — especially the `found` field semantics under each `state`
 * (IMP-0095: absent-mode success must surface as `found:false`, not `found:true`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { awaitElementTool } from '@/entrypoints/background/tools/browser/await-element';

let executeScriptMock: ReturnType<typeof vi.fn>;
let sendMessageMock: ReturnType<typeof vi.fn>;
let queryMock: ReturnType<typeof vi.fn>;
let getMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  executeScriptMock = vi.fn().mockResolvedValue([{ result: undefined }]);
  // First sendMessage is the inject-content-script ping (`*_ping` → `{status:'pong'}`),
  // subsequent ones are the actual `waitForElement` IPC. We dispatch on `action`
  // so the same mock handles both.
  sendMessageMock = vi.fn().mockImplementation(async (_tabId: number, msg: any) => {
    if (msg?.action && String(msg.action).endsWith('_ping')) {
      return { status: 'pong' };
    }
    return { success: true, found: true, matched: { ref: 'ref_1', center: { x: 5, y: 5 } } };
  });
  queryMock = vi.fn().mockResolvedValue([{ id: 7 }]);
  getMock = vi.fn().mockResolvedValue({ id: 7 });
  (globalThis.chrome as any).scripting = { executeScript: executeScriptMock };
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    query: queryMock,
    get: getMock,
    sendMessage: sendMessageMock,
  };
});

afterEach(() => {
  // chrome.* state stays on the global; later tests refresh per-property.
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_await_element: arg validation', () => {
  it('rejects when neither selector nor ref is supplied', async () => {
    const res = await awaitElementTool.execute({});
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('Provide ref or selector');
  });

  it('rejects an invalid state', async () => {
    const res = await awaitElementTool.execute({ selector: '#x', state: 'maybe' as any });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('state');
  });

  it('rejects an invalid selectorType', async () => {
    const res = await awaitElementTool.execute({
      selector: '#x',
      selectorType: 'sizzle' as any,
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('selectorType');
  });
});

describe('chrome_await_element: present-mode success', () => {
  it('returns found:true, absent:false, matched populated', async () => {
    const body = parseBody(
      await awaitElementTool.execute({ tabId: 7, selector: '#cta', state: 'present' }),
    );
    expect(body.success).toBe(true);
    expect(body.found).toBe(true);
    expect(body.absent).toBe(false);
    expect(body.state).toBe('present');
    expect(body.matched).toEqual({ ref: 'ref_1', center: { x: 5, y: 5 } });
    expect(body.ref).toBe('ref_1');
    expect(body.selector).toBe('#cta');
  });

  it('defaults state to "present" when omitted', async () => {
    const body = parseBody(await awaitElementTool.execute({ tabId: 7, selector: '#cta' }));
    expect(body.state).toBe('present');
    expect(body.found).toBe(true);
  });

  it('echoes the caller-supplied ref when used for targeting', async () => {
    const body = parseBody(
      await awaitElementTool.execute({ tabId: 7, ref: 'ref_42', state: 'present' }),
    );
    expect(body.ref).toBe('ref_42');
    expect(body.selector).toBeUndefined();
    expect(body.selectorType).toBeUndefined();
  });
});

describe('chrome_await_element: absent-mode success (IMP-0095)', () => {
  beforeEach(() => {
    // wait-helper returns success:true regardless of mode; matched is null
    // for absent — the wrapper used to mis-shape this as found:true.
    sendMessageMock.mockImplementation(async (_tabId: number, msg: any) => {
      if (msg?.action && String(msg.action).endsWith('_ping')) {
        return { status: 'pong' };
      }
      return { success: true, matched: null, tookMs: 12 };
    });
  });

  it('returns found:false when the element successfully disappears', async () => {
    const body = parseBody(
      await awaitElementTool.execute({ tabId: 7, selector: '#modal', state: 'absent' }),
    );
    expect(body.success).toBe(true);
    expect(body.found).toBe(false);
    expect(body.absent).toBe(true);
    expect(body.matched).toBeNull();
    expect(body.state).toBe('absent');
    expect(body.elapsedMs).toBe(12);
  });

  it('does not synthesize a ref from a null matched on absent-mode', async () => {
    const body = parseBody(
      await awaitElementTool.execute({ tabId: 7, selector: '#modal', state: 'absent' }),
    );
    expect(body.ref).toBeUndefined();
  });

  it('preserves the caller-supplied ref on absent-mode success', async () => {
    const body = parseBody(
      await awaitElementTool.execute({ tabId: 7, ref: 'ref_77', state: 'absent' }),
    );
    expect(body.ref).toBe('ref_77');
    expect(body.found).toBe(false);
    expect(body.absent).toBe(true);
  });
});

describe('chrome_await_element: timeout', () => {
  it('returns a TIMEOUT envelope when the wait-helper reports timeout', async () => {
    sendMessageMock.mockImplementation(async (_tabId: number, msg: any) => {
      if (msg?.action && String(msg.action).endsWith('_ping')) {
        return { status: 'pong' };
      }
      return { success: false, reason: 'timeout', tookMs: 200 };
    });
    const res = await awaitElementTool.execute({
      tabId: 7,
      selector: '#never',
      state: 'absent',
      timeoutMs: 100,
    });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toContain('TIMEOUT');
    expect(text).toContain('absent');
    // No `found` / `absent` fields on the error envelope — those only ride the
    // success path. Callers see the error code, not a boolean.
    expect(text).not.toContain('"found"');
  });
});
