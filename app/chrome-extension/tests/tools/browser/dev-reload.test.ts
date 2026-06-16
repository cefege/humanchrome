/**
 * chrome_dev_reload tests (IMP-0109).
 *
 * Verifies the response flushes before chrome.runtime.reload() fires —
 * the load-bearing ordering property that lets the matrix runner see
 * the success envelope even though the SW is about to be torn down.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { devReloadTool } from '@/entrypoints/background/tools/browser/dev-reload';
import { TOOL_NAMES } from 'humanchrome-shared';

let reloadMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  reloadMock = vi.fn();
  (globalThis.chrome as any).runtime.reload = reloadMock;
});

afterEach(async () => {
  // Drain any pending setTimeout(reload) so it fires on THIS test's mock
  // rather than escaping into the next test's beforeEach (where the mock
  // has been re-stubbed and the prior test's deferred call would observe
  // a fresh, zero-counted spy).
  await new Promise((r) => setTimeout(r, 10));
  delete (globalThis.chrome as any).runtime.reload;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('chrome_dev_reload', () => {
  it('returns success envelope before chrome.runtime.reload fires', async () => {
    const res = await devReloadTool.execute();
    expect(res.isError).toBe(false);
    expect(parseBody(res).success).toBe(true);
    // Response is already returned. Reload is deferred past queueMicrotask
    // + setTimeout(0) so it hasn't fired yet.
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('schedules chrome.runtime.reload() on the next macrotask', async () => {
    await devReloadTool.execute();
    await flush();
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('uses an internal name (folded into chrome_diagnostics)', () => {
    expect(devReloadTool.name).toBe('chrome_diagnostics__dev_reload_internal');
  });

  it('opts out of autoSpawnTab so it does not open a new tab', () => {
    const ctor = devReloadTool.constructor as { autoSpawnTab?: boolean };
    expect(ctor.autoSpawnTab).toBe(false);
  });

  it('accepts an empty args object without erroring', async () => {
    const res = await devReloadTool.execute();
    expect(res.isError).toBe(false);
  });

  it('multiple sequential calls each schedule a fresh reload', async () => {
    await devReloadTool.execute();
    await devReloadTool.execute();
    await devReloadTool.execute();
    await flush();
    expect(reloadMock).toHaveBeenCalledTimes(3);
  });

  it('returns a parseable JSON body with the documented shape', async () => {
    const body = parseBody(await devReloadTool.execute());
    expect(body).toMatchObject({
      success: true,
      message: expect.stringContaining('chrome.runtime.reload'),
    });
  });

  it('response shape matches MCP tool envelope (content[0].text JSON)', async () => {
    const res = await devReloadTool.execute();
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    expect(typeof (res.content[0] as any).text).toBe('string');
    expect(() => JSON.parse((res.content[0] as any).text)).not.toThrow();
  });
});
