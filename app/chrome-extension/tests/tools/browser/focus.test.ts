/**
 * chrome_focus tests.
 *
 * Wraps `chrome.scripting.executeScript` with an ISOLATED-world shim that
 * resolves a target by selector or ref, calls `.focus()`, and reports back
 * whether `document.activeElement` actually moved. Tests stub
 * chrome.scripting.executeScript and chrome.tabs.query and assert the
 * tool's contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { focusTool } from '@/entrypoints/background/tools/browser/focus';

let executeScriptMock: ReturnType<typeof vi.fn>;
let queryMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  executeScriptMock = vi
    .fn()
    .mockResolvedValue([
      { result: { ok: true, focused: true, resolution: 'selector', tagName: 'input' } },
    ]);
  queryMock = vi.fn().mockResolvedValue([{ id: 7, url: 'https://example.com' }]);

  (globalThis.chrome as any).scripting = { executeScript: executeScriptMock };
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    query: queryMock,
  };
});

afterEach(() => {
  // Leave chrome.tabs and chrome.scripting in place — other tests mutate them.
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_focus', () => {
  it('rejects when neither selector nor ref is supplied', async () => {
    const res = await focusTool.execute({} as any);
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('selector|ref');
  });

  it('rejects when both selector and ref are supplied', async () => {
    const res = await focusTool.execute({ selector: 'input', ref: 'r1' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('selector|ref');
  });

  it('forwards selector via the shim and reports focused:true', async () => {
    const res = await focusTool.execute({ tabId: 42, selector: '#email' });
    expect(res.isError).toBe(false);
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 42 },
        world: 'ISOLATED',
        args: ['#email', null],
      }),
    );
    const body = parseBody(res);
    expect(body.tabId).toBe(42);
    expect(body.focused).toBe(true);
    expect(body.resolution).toBe('selector');
    expect(body.tagName).toBe('input');
  });

  it('forwards ref via the shim and reports resolution:ref', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: true, focused: true, resolution: 'ref', tagName: 'button' } },
    ]);
    const res = await focusTool.execute({ tabId: 42, ref: 'r-99' });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ args: [null, 'r-99'] }),
    );
    expect(parseBody(res).resolution).toBe('ref');
  });

  it('falls back to the active tab when no tabId is provided', async () => {
    await focusTool.execute({ selector: 'input' });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 } }),
    );
  });

  it('uses the windowId for active-tab lookup', async () => {
    queryMock.mockResolvedValueOnce([{ id: 99 }]);
    await focusTool.execute({ selector: 'input', windowId: 3 });
    expect(queryMock).toHaveBeenCalledWith({ active: true, windowId: 3 });
  });

  it('forwards frameId when supplied', async () => {
    await focusTool.execute({ tabId: 7, selector: 'input', frameId: 11 });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7, frameIds: [11] } }),
    );
  });

  it('reports focused:false when the element exists but does not accept focus', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: true, focused: false, resolution: 'selector', tagName: 'div' } },
    ]);
    const body = parseBody(await focusTool.execute({ tabId: 7, selector: 'div' }));
    expect(body.focused).toBe(false);
  });

  it('surfaces a shim ok:false (selector matched no element)', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: false, message: 'selector "#nope" matched no element' } },
    ]);
    const res = await focusTool.execute({ tabId: 7, selector: '#nope' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('matched no element');
  });

  it('surfaces a shim ok:false (ref not in element map)', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: false, message: 'ref "r-x" not found in element map' } },
    ]);
    const res = await focusTool.execute({ tabId: 7, ref: 'r-x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('not found in element map');
  });

  it('classifies "no tab with id" rejection as TAB_CLOSED', async () => {
    executeScriptMock.mockRejectedValueOnce(new Error('No tab with id: 99'));
    const res = await focusTool.execute({ tabId: 99, selector: 'input' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_CLOSED');
  });

  it('returns an error when the shim returns no result (frame missing)', async () => {
    executeScriptMock.mockResolvedValueOnce([]);
    const res = await focusTool.execute({ tabId: 7, selector: 'input' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('no result');
  });

  it('returns TAB_NOT_FOUND when there is no active tab', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await focusTool.execute({ selector: 'input' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_NOT_FOUND');
  });
});
