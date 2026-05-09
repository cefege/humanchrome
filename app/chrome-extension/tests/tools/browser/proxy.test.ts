/**
 * chrome_proxy tests.
 *
 * Wraps chrome.proxy.settings.{set,clear,get}.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { proxyTool } from '@/entrypoints/background/tools/browser/proxy';

let setMock: ReturnType<typeof vi.fn>;
let clearMock: ReturnType<typeof vi.fn>;
let getMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setMock = vi.fn().mockResolvedValue(undefined);
  clearMock = vi.fn().mockResolvedValue(undefined);
  getMock = vi.fn().mockImplementation((_q: any, cb: (details: any) => void) =>
    cb({
      value: { mode: 'system' },
      levelOfControl: 'controlled_by_this_extension',
      incognitoSpecific: false,
    }),
  );
  (globalThis.chrome as any).proxy = {
    settings: { set: setMock, clear: clearMock, get: getMock },
  };
});

afterEach(() => {
  delete (globalThis.chrome as any).proxy;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_proxy', () => {
  it('rejects unknown action', async () => {
    const res = await proxyTool.execute({} as any);
    expect(res.isError).toBe(true);
  });

  it('errors when chrome.proxy is undefined', async () => {
    delete (globalThis.chrome as any).proxy;
    const res = await proxyTool.execute({ action: 'get' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('chrome.proxy is unavailable');
  });

  it('set requires mode', async () => {
    const res = await proxyTool.execute({ action: 'set' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('mode');
  });

  it('set mode="direct" forwards a direct config', async () => {
    await proxyTool.execute({ action: 'set', mode: 'direct' });
    expect(setMock).toHaveBeenCalledWith({ value: { mode: 'direct' }, scope: 'regular' });
  });

  it('set mode="system" forwards a system config', async () => {
    await proxyTool.execute({ action: 'set', mode: 'system' });
    expect(setMock).toHaveBeenCalledWith({ value: { mode: 'system' }, scope: 'regular' });
  });

  it('set mode="fixed_servers" requires singleProxy with host+port', async () => {
    const res = await proxyTool.execute({ action: 'set', mode: 'fixed_servers' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('singleProxy');
  });

  it('set mode="fixed_servers" forwards singleProxy + bypassList', async () => {
    await proxyTool.execute({
      action: 'set',
      mode: 'fixed_servers',
      singleProxy: { host: 'proxy.example.com', port: 8080 },
      bypassList: ['localhost', '127.0.0.1'],
    });
    expect(setMock).toHaveBeenCalledWith({
      value: {
        mode: 'fixed_servers',
        rules: {
          singleProxy: { scheme: 'http', host: 'proxy.example.com', port: 8080 },
          bypassList: ['localhost', '127.0.0.1'],
        },
      },
      scope: 'regular',
    });
  });

  it('set mode="fixed_servers" honors a custom scheme', async () => {
    await proxyTool.execute({
      action: 'set',
      mode: 'fixed_servers',
      singleProxy: { scheme: 'socks5', host: 'sock.example.com', port: 1080 },
    });
    const call = setMock.mock.calls[0][0];
    expect(call.value.rules.singleProxy.scheme).toBe('socks5');
  });

  it('set mode="pac_script" requires pacUrl', async () => {
    const res = await proxyTool.execute({ action: 'set', mode: 'pac_script' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('pacUrl');
  });

  it('set mode="pac_script" forwards the pacUrl as a mandatory script', async () => {
    await proxyTool.execute({
      action: 'set',
      mode: 'pac_script',
      pacUrl: 'https://example.com/proxy.pac',
    });
    expect(setMock).toHaveBeenCalledWith({
      value: {
        mode: 'pac_script',
        pacScript: { url: 'https://example.com/proxy.pac', mandatory: true },
      },
      scope: 'regular',
    });
  });

  it('clear calls chrome.proxy.settings.clear', async () => {
    await proxyTool.execute({ action: 'clear' });
    expect(clearMock).toHaveBeenCalledWith({ scope: 'regular' });
  });

  it('get returns the current config', async () => {
    const body = parseBody(await proxyTool.execute({ action: 'get' }));
    expect(body.value).toEqual({ mode: 'system' });
    expect(body.levelOfControl).toBe('controlled_by_this_extension');
    expect(body.incognitoSpecific).toBe(false);
  });

  it('surfaces a chrome.proxy rejection on set', async () => {
    setMock.mockRejectedValueOnce(new Error('policy override'));
    const res = await proxyTool.execute({ action: 'set', mode: 'system' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('policy override');
  });
});
