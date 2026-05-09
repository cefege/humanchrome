/**
 * chrome_network_emulate tests.
 *
 * Wraps chrome.debugger.sendCommand('Network.emulateNetworkConditions').
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { networkEmulateTool } from '@/entrypoints/background/tools/browser/network-emulate';

let attachMock: ReturnType<typeof vi.fn>;
let detachMock: ReturnType<typeof vi.fn>;
let sendCommandMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  attachMock = vi.fn().mockResolvedValue(undefined);
  detachMock = vi.fn().mockResolvedValue(undefined);
  sendCommandMock = vi.fn().mockResolvedValue({});
  (globalThis.chrome as any).debugger = {
    attach: attachMock,
    detach: detachMock,
    sendCommand: sendCommandMock,
  };
});

afterEach(() => {
  delete (globalThis.chrome as any).debugger;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_network_emulate', () => {
  it('rejects unknown action', async () => {
    const res = await networkEmulateTool.execute({ tabId: 1 } as any);
    expect(res.isError).toBe(true);
  });

  it('rejects missing tabId', async () => {
    const res = await networkEmulateTool.execute({ action: 'set' } as any);
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('tabId');
  });

  it('set attaches the debugger and sends emulateNetworkConditions', async () => {
    await networkEmulateTool.execute({
      action: 'set',
      tabId: 7,
      offline: false,
      latencyMs: 500,
      downloadKbps: 1024,
      uploadKbps: 256,
    });
    expect(attachMock).toHaveBeenCalledWith({ tabId: 7 }, '1.3');
    const params = sendCommandMock.mock.calls[0][2];
    expect(params.offline).toBe(false);
    expect(params.latency).toBe(500);
    // 1024 kbps → 1024 * (1024/8) = 131072 bytes/sec
    expect(params.downloadThroughput).toBe(1024 * (1024 / 8));
    expect(params.uploadThroughput).toBe(256 * (1024 / 8));
  });

  it('set leaves the debugger attached for follow-up calls', async () => {
    await networkEmulateTool.execute({ action: 'set', tabId: 7, offline: true });
    expect(detachMock).not.toHaveBeenCalled();
  });

  it('reset clears conditions and detaches', async () => {
    await networkEmulateTool.execute({ action: 'reset', tabId: 7 });
    const params = sendCommandMock.mock.calls[0][2];
    expect(params).toEqual({
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    expect(detachMock).toHaveBeenCalledWith({ tabId: 7 });
  });

  it('treats "already attached" as success and proceeds', async () => {
    attachMock.mockRejectedValueOnce(new Error('Another debugger is already attached'));
    const res = await networkEmulateTool.execute({ action: 'set', tabId: 7 });
    expect(res.isError).toBe(false);
    expect(sendCommandMock).toHaveBeenCalled();
  });

  it('classifies "no tab with id" as TAB_CLOSED', async () => {
    sendCommandMock.mockRejectedValueOnce(new Error('No tab with id: 7'));
    const res = await networkEmulateTool.execute({ action: 'set', tabId: 7 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_CLOSED');
  });

  it('on error best-effort detaches', async () => {
    sendCommandMock.mockRejectedValueOnce(new Error('something broke'));
    await networkEmulateTool.execute({ action: 'set', tabId: 7 });
    expect(detachMock).toHaveBeenCalledWith({ tabId: 7 });
  });

  it('omitting downloadKbps leaves throughput uncapped (-1)', async () => {
    await networkEmulateTool.execute({ action: 'set', tabId: 7 });
    const params = sendCommandMock.mock.calls[0][2];
    expect(params.downloadThroughput).toBe(-1);
    expect(params.uploadThroughput).toBe(-1);
  });
});
