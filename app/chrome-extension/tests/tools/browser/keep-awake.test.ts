/**
 * chrome_keep_awake tests.
 *
 * Wraps chrome.power.requestKeepAwake / releaseKeepAwake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { keepAwakeTool } from '@/entrypoints/background/tools/browser/keep-awake';

let requestMock: ReturnType<typeof vi.fn>;
let releaseMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  requestMock = vi.fn();
  releaseMock = vi.fn();
  (globalThis.chrome as any).power = {
    requestKeepAwake: requestMock,
    releaseKeepAwake: releaseMock,
  };
});

afterEach(() => {
  delete (globalThis.chrome as any).power;
});

describe('chrome_keep_awake', () => {
  it('rejects unknown action', async () => {
    const res = await keepAwakeTool.execute({} as any);
    expect(res.isError).toBe(true);
  });

  it('errors when chrome.power is undefined', async () => {
    delete (globalThis.chrome as any).power;
    const res = await keepAwakeTool.execute({ action: 'enable', level: 'display' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('chrome.power is unavailable');
  });

  it('enable requires level', async () => {
    const res = await keepAwakeTool.execute({ action: 'enable' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('level');
  });

  it('enable("display") forwards the level', async () => {
    const res = await keepAwakeTool.execute({ action: 'enable', level: 'display' });
    expect(res.isError).toBe(false);
    expect(requestMock).toHaveBeenCalledWith('display');
  });

  it('enable("system") forwards the level', async () => {
    await keepAwakeTool.execute({ action: 'enable', level: 'system' });
    expect(requestMock).toHaveBeenCalledWith('system');
  });

  it('disable releases the lock', async () => {
    const res = await keepAwakeTool.execute({ action: 'disable' });
    expect(res.isError).toBe(false);
    expect(releaseMock).toHaveBeenCalled();
  });

  it('rejects an invalid level', async () => {
    const res = await keepAwakeTool.execute({ action: 'enable', level: 'cpu' as any });
    expect(res.isError).toBe(true);
  });
});
