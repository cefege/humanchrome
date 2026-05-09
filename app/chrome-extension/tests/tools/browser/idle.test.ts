/**
 * chrome_idle tests.
 *
 * Wraps chrome.idle.queryState. Tests stub the API and assert the contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { idleTool } from '@/entrypoints/background/tools/browser/idle';

let queryStateMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  queryStateMock = vi
    .fn()
    .mockImplementation((_interval: number, cb: (state: string) => void) => cb('active'));
  (globalThis.chrome as any).idle = { queryState: queryStateMock };
});

afterEach(() => {
  delete (globalThis.chrome as any).idle;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_idle', () => {
  it('errors when chrome.idle is undefined', async () => {
    delete (globalThis.chrome as any).idle;
    const res = await idleTool.execute({});
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('chrome.idle is unavailable');
  });

  it('uses the default 60-second interval when omitted', async () => {
    await idleTool.execute({});
    expect(queryStateMock).toHaveBeenCalledWith(60, expect.any(Function));
  });

  it('forwards a custom interval', async () => {
    await idleTool.execute({ detectionIntervalSec: 300 });
    expect(queryStateMock).toHaveBeenCalledWith(300, expect.any(Function));
  });

  it('rejects an interval below 15 seconds', async () => {
    const res = await idleTool.execute({ detectionIntervalSec: 5 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('detectionIntervalSec');
  });

  it('rejects an interval above 14400 seconds', async () => {
    const res = await idleTool.execute({ detectionIntervalSec: 20000 });
    expect(res.isError).toBe(true);
  });

  it('returns the active state and the interval used', async () => {
    const body = parseBody(await idleTool.execute({ detectionIntervalSec: 60 }));
    expect(body.state).toBe('active');
    expect(body.detectionIntervalSec).toBe(60);
  });

  it('returns the idle state', async () => {
    queryStateMock.mockImplementationOnce((_i: number, cb: (s: string) => void) => cb('idle'));
    const body = parseBody(await idleTool.execute({}));
    expect(body.state).toBe('idle');
  });

  it('returns the locked state', async () => {
    queryStateMock.mockImplementationOnce((_i: number, cb: (s: string) => void) => cb('locked'));
    const body = parseBody(await idleTool.execute({}));
    expect(body.state).toBe('locked');
  });
});
