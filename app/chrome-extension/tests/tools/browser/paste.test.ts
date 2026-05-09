/**
 * chrome_paste tests.
 *
 * Focus + (optional clipboard seed via offscreen) + synthetic ClipboardEvent
 * + execCommand fallback. Tests stub chrome.scripting.executeScript and the
 * offscreen sendMessage path; they don't try to exercise the in-page shim.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/offscreen-manager', () => ({
  offscreenManager: {
    ensureOffscreenDocument: vi.fn().mockResolvedValue(undefined),
  },
}));

import { pasteTool } from '@/entrypoints/background/tools/browser/paste';
import { offscreenManager } from '@/utils/offscreen-manager';

let executeScriptMock: ReturnType<typeof vi.fn>;
let queryMock: ReturnType<typeof vi.fn>;
let sendMessageMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  executeScriptMock = vi.fn().mockResolvedValue([
    {
      result: {
        ok: true,
        focused: true,
        resolution: 'selector',
        tagName: 'input',
        pasted: true,
        mode: 'both',
      },
    },
  ]);
  queryMock = vi.fn().mockResolvedValue([{ id: 7, url: 'https://example.com' }]);
  sendMessageMock = vi.fn().mockResolvedValue({ success: true });

  (globalThis.chrome as any).scripting = { executeScript: executeScriptMock };
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    query: queryMock,
  };
  (globalThis.chrome as any).runtime = {
    ...(globalThis.chrome as any).runtime,
    sendMessage: sendMessageMock,
  };
  (offscreenManager.ensureOffscreenDocument as any).mockClear();
  (offscreenManager.ensureOffscreenDocument as any).mockResolvedValue(undefined);
});

afterEach(() => {
  // chrome.runtime / chrome.tabs are shared with other tests.
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_paste', () => {
  it('rejects when neither selector nor ref is supplied', async () => {
    const res = await pasteTool.execute({});
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('selector|ref');
  });

  it('rejects when both selector and ref are supplied', async () => {
    const res = await pasteTool.execute({ selector: 'input', ref: 'r1' });
    expect(res.isError).toBe(true);
  });

  it('without text, does NOT call the offscreen clipboard.write', async () => {
    await pasteTool.execute({ tabId: 7, selector: 'input' });
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(offscreenManager.ensureOffscreenDocument).not.toHaveBeenCalled();
  });

  it('with text, seeds the clipboard via the offscreen doc before paste', async () => {
    await pasteTool.execute({ tabId: 7, selector: 'input', text: 'hello' });
    expect(offscreenManager.ensureOffscreenDocument).toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledWith({
      target: 'offscreen',
      type: 'clipboard.write',
      text: 'hello',
    });
  });

  it('forwards selector + text via the shim args', async () => {
    await pasteTool.execute({ tabId: 7, selector: '#email', text: 'hi' });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7 },
        world: 'ISOLATED',
        args: ['#email', null, 'hi'],
      }),
    );
  });

  it('forwards ref via the shim args', async () => {
    await pasteTool.execute({ tabId: 7, ref: 'r-99', text: 'x' });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ args: [null, 'r-99', 'x'] }),
    );
  });

  it('falls back to the active tab when no tabId is provided', async () => {
    await pasteTool.execute({ selector: 'input' });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 } }),
    );
  });

  it('forwards frameId when supplied', async () => {
    await pasteTool.execute({ tabId: 7, selector: 'input', frameId: 11 });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7, frameIds: [11] } }),
    );
  });

  it('reports mode and pasted from the shim result', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: true,
          focused: true,
          resolution: 'selector',
          tagName: 'input',
          pasted: true,
          mode: 'event',
        },
      },
    ]);
    const body = parseBody(await pasteTool.execute({ tabId: 7, selector: 'input', text: 'x' }));
    expect(body.mode).toBe('event');
    expect(body.pasted).toBe(true);
  });

  it('surfaces a shim ok:false (selector matched no element)', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: false, message: 'selector "#nope" matched no element' } },
    ]);
    const res = await pasteTool.execute({ tabId: 7, selector: '#nope', text: 'x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('matched no element');
  });

  it('reports a clipboard-seed failure as UNKNOWN', async () => {
    sendMessageMock.mockResolvedValueOnce({ success: false, error: 'NotAllowedError' });
    const res = await pasteTool.execute({ tabId: 7, selector: 'input', text: 'x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('NotAllowedError');
    expect(executeScriptMock).not.toHaveBeenCalled();
  });

  it('classifies "no tab with id" as TAB_CLOSED', async () => {
    executeScriptMock.mockRejectedValueOnce(new Error('No tab with id: 99'));
    const res = await pasteTool.execute({ tabId: 99, selector: 'input' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_CLOSED');
  });

  it('returns TAB_NOT_FOUND when there is no active tab', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await pasteTool.execute({ selector: 'input' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_NOT_FOUND');
  });

  it('returns an error when the shim returns no result', async () => {
    executeScriptMock.mockResolvedValueOnce([]);
    const res = await pasteTool.execute({ tabId: 7, selector: 'input' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('no result');
  });
});
