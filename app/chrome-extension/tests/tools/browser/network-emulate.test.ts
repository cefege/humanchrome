/**
 * chrome_network_emulate tests.
 *
 * Wraps cdpSessionManager to send Network.emulateNetworkConditions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const attachMock = vi.fn(async () => undefined);
const detachMock = vi.fn(async () => undefined);
const sendCommandMock = vi.fn(async () => ({}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: (...args: unknown[]) => (attachMock as (...a: unknown[]) => unknown)(...args),
    detach: (...args: unknown[]) => (detachMock as (...a: unknown[]) => unknown)(...args),
    sendCommand: (...args: unknown[]) => (sendCommandMock as (...a: unknown[]) => unknown)(...args),
    withSession: vi.fn(),
  },
}));

import { networkEmulateTool } from '@/entrypoints/background/tools/browser/network-emulate';

beforeEach(() => {
  attachMock.mockClear();
  detachMock.mockClear();
  sendCommandMock.mockReset();
  sendCommandMock.mockResolvedValue({});
  (globalThis.chrome as any).debugger = {};
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

  it('set attaches via session manager and sends emulateNetworkConditions', async () => {
    await networkEmulateTool.execute({
      action: 'set',
      tabId: 7,
      offline: false,
      latencyMs: 500,
      downloadKbps: 1024,
      uploadKbps: 256,
    });
    expect(attachMock).toHaveBeenCalledWith(7, 'network-emulate');
    const call = sendCommandMock.mock.calls[0] as unknown as [unknown, string, any];
    expect(call[1]).toBe('Network.emulateNetworkConditions');
    const params = call[2];
    expect(params.offline).toBe(false);
    expect(params.latency).toBe(500);
    // 1024 kbps → 1024 * (1024/8) = 131072 bytes/sec
    expect(params.downloadThroughput).toBe(1024 * (1024 / 8));
    expect(params.uploadThroughput).toBe(256 * (1024 / 8));
  });

  it('set leaves the session attached for follow-up calls', async () => {
    await networkEmulateTool.execute({ action: 'set', tabId: 7, offline: true });
    expect(detachMock).not.toHaveBeenCalled();
  });

  it('reset clears conditions and detaches via session manager', async () => {
    await networkEmulateTool.execute({ action: 'reset', tabId: 7 });
    const call = sendCommandMock.mock.calls[0] as unknown as [unknown, string, any];
    expect(call[1]).toBe('Network.emulateNetworkConditions');
    expect(call[2]).toEqual({
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    expect(detachMock).toHaveBeenCalledWith(7, 'network-emulate');
  });

  it('classifies "Another CDP client" attach error as CDP_BUSY', async () => {
    attachMock.mockRejectedValueOnce(new Error('Another CDP client is attached to tab 7'));
    const res = await networkEmulateTool.execute({ action: 'set', tabId: 7 });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.code).toBe('CDP_BUSY');
  });

  it('classifies "no tab with id" as TAB_CLOSED', async () => {
    sendCommandMock.mockRejectedValueOnce(new Error('No tab with id: 7'));
    const res = await networkEmulateTool.execute({ action: 'set', tabId: 7 });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.code).toBe('TAB_CLOSED');
  });

  it('on error detaches via session manager', async () => {
    sendCommandMock.mockRejectedValueOnce(new Error('something broke'));
    await networkEmulateTool.execute({ action: 'set', tabId: 7 });
    expect(detachMock).toHaveBeenCalledWith(7, 'network-emulate');
  });

  it('omitting downloadKbps leaves throughput uncapped (-1)', async () => {
    await networkEmulateTool.execute({ action: 'set', tabId: 7 });
    const call = sendCommandMock.mock.calls[0] as unknown as [unknown, string, any];
    expect(call[2].downloadThroughput).toBe(-1);
    expect(call[2].uploadThroughput).toBe(-1);
  });
});
