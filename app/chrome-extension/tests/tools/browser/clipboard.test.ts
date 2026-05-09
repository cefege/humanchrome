/**
 * chrome_clipboard tests.
 *
 * The tool dispatches read/write through the offscreen document. Stubs the
 * offscreen-manager and chrome.runtime.sendMessage and asserts the contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/offscreen-manager', () => ({
  offscreenManager: {
    ensureOffscreenDocument: vi.fn().mockResolvedValue(undefined),
  },
}));

import { clipboardTool } from '@/entrypoints/background/tools/browser/clipboard';
import { offscreenManager } from '@/utils/offscreen-manager';

let sendMessageMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sendMessageMock = vi.fn();
  (globalThis.chrome as any).runtime = {
    ...(globalThis.chrome as any).runtime,
    sendMessage: sendMessageMock,
  };
  (offscreenManager.ensureOffscreenDocument as any).mockClear();
  (offscreenManager.ensureOffscreenDocument as any).mockResolvedValue(undefined);
});

afterEach(() => {
  // chrome.runtime stays on the global; other tests might rely on it.
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_clipboard', () => {
  it('rejects unknown action', async () => {
    const res = await clipboardTool.execute({} as any);
    expect(res.isError).toBe(true);
  });

  it('write requires text', async () => {
    const res = await clipboardTool.execute({ action: 'write' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('text');
  });

  it('read sends a clipboard.read message and returns the result', async () => {
    sendMessageMock.mockResolvedValue({ success: true, result: 'hello' });
    const res = await clipboardTool.execute({ action: 'read' });
    expect(res.isError).toBe(false);
    expect(offscreenManager.ensureOffscreenDocument).toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledWith({
      target: 'offscreen',
      type: 'clipboard.read',
    });
    expect(parseBody(res).text).toBe('hello');
  });

  it('write sends a clipboard.write message and reports written:true', async () => {
    sendMessageMock.mockResolvedValue({ success: true });
    const res = await clipboardTool.execute({ action: 'write', text: 'hi' });
    expect(res.isError).toBe(false);
    expect(sendMessageMock).toHaveBeenCalledWith({
      target: 'offscreen',
      type: 'clipboard.write',
      text: 'hi',
    });
    expect(parseBody(res).written).toBe(true);
  });

  it('surfaces an offscreen error', async () => {
    sendMessageMock.mockResolvedValue({ success: false, error: 'NotAllowedError' });
    const res = await clipboardTool.execute({ action: 'read' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('NotAllowedError');
  });

  it('surfaces a sendMessage rejection', async () => {
    sendMessageMock.mockRejectedValueOnce(new Error('disconnected'));
    const res = await clipboardTool.execute({ action: 'read' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('disconnected');
  });

  it('returns empty string when offscreen returns success but no result', async () => {
    sendMessageMock.mockResolvedValue({ success: true });
    const body = parseBody(await clipboardTool.execute({ action: 'read' }));
    expect(body.text).toBe('');
  });

  it('reports the offscreen-manager init failure', async () => {
    (offscreenManager.ensureOffscreenDocument as any).mockRejectedValueOnce(
      new Error('offscreen broken'),
    );
    const res = await clipboardTool.execute({ action: 'read' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('offscreen broken');
  });
});
