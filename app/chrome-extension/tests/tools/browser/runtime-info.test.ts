/**
 * chrome_runtime_info tests (IMP-0109).
 *
 * Diagnostic tool returning SW identity for E2E runners. Tests assert the
 * payload shape, build-time-define plumbing, and that listRegisteredToolNames
 * surfaces the real dispatcher registry (so a SW running stale code can be
 * detected by comparing toolNames or buildHash).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runtimeInfoTool } from '@/entrypoints/background/tools/browser/runtime-info';
import { TOOL_NAMES } from 'humanchrome-shared';

let getManifestMock: ReturnType<typeof vi.fn>;

// Warm the dispatcher import once per file. runtimeInfoTool.execute()
// does `await import('../index')` to break a static-import cycle; that
// pulls the eager dispatcher graph (which post bug #216 includes
// javascript/read-page/userscript/performance/element-picker as static
// imports). Under parallel-runner contention the first warm-up can take
// several seconds — paying it once in beforeAll keeps every individual
// test sub-millisecond instead of flaking on the 5s default per-test
// timeout. The build-time defines must be stubbed here too, since
// beforeAll runs BEFORE the per-test beforeEach.
beforeAll(async () => {
  vi.stubGlobal('__HC_BUILD_HASH__', 'warmup-hash');
  vi.stubGlobal('__HC_BUILT_AT__', '2026-01-01T00:00:00.000Z');
  (globalThis.chrome as any).runtime.getManifest = vi.fn().mockReturnValue({ version: 'warmup' });
  await runtimeInfoTool.execute();
}, 30_000);

beforeEach(() => {
  vi.stubGlobal('__HC_BUILD_HASH__', 'test-hash-abc123');
  vi.stubGlobal('__HC_BUILT_AT__', '2026-01-01T00:00:00.000Z');
  getManifestMock = vi.fn().mockReturnValue({ version: '9.9.9-test' });
  (globalThis.chrome as any).runtime.getManifest = getManifestMock;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis.chrome as any).runtime.getManifest;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_runtime_info', () => {
  it('returns extensionVersion from chrome.runtime.getManifest()', async () => {
    const body = parseBody(await runtimeInfoTool.execute());
    expect(body.extensionVersion).toBe('9.9.9-test');
    expect(getManifestMock).toHaveBeenCalled();
  });

  it('returns extensionId from chrome.runtime.id', async () => {
    const body = parseBody(await runtimeInfoTool.execute());
    expect(body.extensionId).toBe('test-extension-id');
  });

  it('returns toolNames sorted ascending', async () => {
    const body = parseBody(await runtimeInfoTool.execute());
    expect(Array.isArray(body.toolNames)).toBe(true);
    const sorted = [...body.toolNames].sort();
    expect(body.toolNames).toEqual(sorted);
  });

  it('reports toolCount that matches toolNames.length', async () => {
    const body = parseBody(await runtimeInfoTool.execute());
    expect(body.toolCount).toBe(body.toolNames.length);
  });

  it('includes the diagnostics tool name in toolNames (registry round-trip)', async () => {
    const body = parseBody(await runtimeInfoTool.execute());
    expect(body.toolNames).toContain(TOOL_NAMES.BROWSER.DIAGNOSTICS);
  });

  it('includes a well-known stable tool name (chrome_pace) — sanity check on registry', async () => {
    const body = parseBody(await runtimeInfoTool.execute());
    expect(body.toolNames).toContain(TOOL_NAMES.BROWSER.PACE);
  });

  it('reports the build-time-injected buildHash', async () => {
    const body = parseBody(await runtimeInfoTool.execute());
    expect(body.buildHash).toBe('test-hash-abc123');
  });

  it('reports the build-time-injected builtAt timestamp', async () => {
    const body = parseBody(await runtimeInfoTool.execute());
    expect(body.builtAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('reports uptimeMs as a non-negative number', async () => {
    const body = parseBody(await runtimeInfoTool.execute());
    expect(typeof body.uptimeMs).toBe('number');
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it('uptimeMs grows across two calls (monotonic non-decreasing)', async () => {
    const a = parseBody(await runtimeInfoTool.execute());
    await new Promise((r) => setTimeout(r, 5));
    const b = parseBody(await runtimeInfoTool.execute());
    expect(b.uptimeMs).toBeGreaterThanOrEqual(a.uptimeMs);
  });

  it('uses an internal name (folded into chrome_diagnostics)', () => {
    expect(runtimeInfoTool.name).toBe('chrome_diagnostics__runtime_info_internal');
  });

  it('opts out of autoSpawnTab', () => {
    const ctor = runtimeInfoTool.constructor as { autoSpawnTab?: boolean };
    expect(ctor.autoSpawnTab).toBe(false);
  });
});
