/**
 * chrome_inject_script — timeout + CSP detection (bug #217).
 *
 * Pre-fix, `chrome.scripting.executeScript` calls in `handleInject` were
 * unbounded. A page that silently absorbed the injection (freelancermap.de
 * was the reproducer) caused the tool to hang for the full 120s MCP
 * transport budget. The MAIN-world path also returned `{injected:true}`
 * even when the page's CSP refused to evaluate the function, because the
 * per-frame `result.error` was never inspected.
 *
 * This file pins the new contract:
 *   - Hung executeScript → INJECTION_TIMEOUT after 5s (not 120s).
 *   - Per-frame CSP rejection → INJECTION_FAILED with reason:'CSP_BLOCKED'.
 *   - Per-frame generic error → INJECTION_FAILED with reason:'INJECTION_ERROR'.
 *   - Happy path → unchanged `{injected:true, success:true}` payload.
 *
 * Vitest fake timers drive the timeout test so we don't actually wait 5s.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function installChromeMock() {
  (globalThis.chrome as any) = {
    tabs: {
      get: vi.fn(async (id: number) => ({ id, url: `https://tab-${id}.example/` })),
      query: vi.fn().mockResolvedValue([{ id: 1 }]),
      update: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn().mockResolvedValue({ ok: true }),
      create: vi.fn().mockResolvedValue({ id: 99 }),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: { update: vi.fn().mockResolvedValue({}) },
    scripting: { executeScript: vi.fn() },
    runtime: { id: 'test-ext' },
  };
}

async function loadModule() {
  vi.resetModules();
  return await import('@/entrypoints/background/tools/browser/inject-script');
}

function parse(text: string) {
  return JSON.parse(text);
}

beforeEach(() => {
  installChromeMock();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('chrome_inject_script — INJECTION_TIMEOUT (bug #217)', () => {
  it('returns INJECTION_TIMEOUT after 5s when executeScript hangs', async () => {
    vi.useFakeTimers();
    const mod = await loadModule();

    // executeScript never resolves — emulates a page that absorbs the
    // injection without surfacing an error (freelancermap.de's symptom).
    (globalThis.chrome as any).scripting.executeScript = vi.fn(() => new Promise(() => {}));

    const promise = mod.injectScriptTool.execute({
      tabId: 7,
      type: 'MAIN' as any,
      jsScript: 'console.log("never runs")',
    });

    // 4.5s in — still pending. The 120s MCP budget would have eaten this.
    await vi.advanceTimersByTimeAsync(4500);
    let settled = false;
    promise.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    // Crossing the 5s budget — tool resolves with INJECTION_TIMEOUT.
    await vi.advanceTimersByTimeAsync(600);
    const res = await promise;

    expect(res.isError).toBe(true);
    const body = parse((res.content[0] as any).text);
    expect(body.error.code).toBe('INJECTION_TIMEOUT');
    expect(body.error.message).toMatch(/did not return within 5000ms/);
    expect(body.error.details).toMatchObject({
      tabId: 7,
      phase: 'bridge inject',
      timeoutMs: 5000,
    });
  });

  it('does not poison the injectedTabs map when the timeout fires', async () => {
    vi.useFakeTimers();
    const mod = await loadModule();

    (globalThis.chrome as any).scripting.executeScript = vi.fn(() => new Promise(() => {}));

    const exec = mod.injectScriptTool.execute({
      tabId: 42,
      type: 'ISOLATED' as any,
      jsScript: 'x',
    });
    await vi.advanceTimersByTimeAsync(6000);
    await exec;

    // The list tool would have shown a stale entry if the timeout path
    // had cached the inject before failing.
    const list = await mod.listInjectedScriptsTool.execute({ tabId: 42 });
    const body = parse((list.content[0] as any).text);
    expect(body.count).toBe(0);
  });
});

describe('chrome_inject_script — CSP detection (bug #217)', () => {
  it('flags LinkedIn-style strict-dynamic rejection as CSP_BLOCKED', async () => {
    const mod = await loadModule();

    // Bridge inject succeeds (no error); MAIN-world inject reports the
    // CSP rejection in the per-frame result.error, not as a throw.
    (globalThis.chrome as any).scripting.executeScript = vi
      .fn()
      // bridge inject ok
      .mockResolvedValueOnce([{ result: undefined }])
      // MAIN-world inject — page CSP refused
      .mockResolvedValueOnce([
        {
          error: {
            message:
              "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'strict-dynamic' 'nonce-abc123'\".",
          },
        },
      ]);

    const res = await mod.injectScriptTool.execute({
      tabId: 5,
      type: 'MAIN' as any,
      jsScript: 'document.title',
    });

    expect(res.isError).toBe(true);
    const body = parse((res.content[0] as any).text);
    expect(body.error.code).toBe('INJECTION_FAILED');
    expect(body.error.details.reason).toBe('CSP_BLOCKED');
    expect(body.error.message).toMatch(/Refused to evaluate/);
  });

  it('flags Gmail-style unsafe-eval rejection as CSP_BLOCKED', async () => {
    const mod = await loadModule();

    (globalThis.chrome as any).scripting.executeScript = vi
      .fn()
      .mockResolvedValueOnce([{ result: undefined }])
      .mockResolvedValueOnce([
        {
          error: { message: "'unsafe-eval' is not an allowed source of script" },
        },
      ]);

    const res = await mod.injectScriptTool.execute({
      tabId: 6,
      type: 'MAIN' as any,
      jsScript: '42',
    });

    expect(res.isError).toBe(true);
    const body = parse((res.content[0] as any).text);
    expect(body.error.details.reason).toBe('CSP_BLOCKED');
  });

  it('classifies non-CSP per-frame errors as INJECTION_ERROR', async () => {
    const mod = await loadModule();

    (globalThis.chrome as any).scripting.executeScript = vi
      .fn()
      .mockResolvedValueOnce([{ result: undefined }])
      .mockResolvedValueOnce([{ error: { message: 'ReferenceError: foo is not defined' } }]);

    const res = await mod.injectScriptTool.execute({
      tabId: 8,
      type: 'MAIN' as any,
      jsScript: 'foo()',
    });

    expect(res.isError).toBe(true);
    const body = parse((res.content[0] as any).text);
    expect(body.error.code).toBe('INJECTION_FAILED');
    expect(body.error.details.reason).toBe('INJECTION_ERROR');
    expect(body.error.message).toMatch(/ReferenceError/);
  });

  it('does NOT record the failed CSP-blocked inject in injectedTabs', async () => {
    const mod = await loadModule();

    (globalThis.chrome as any).scripting.executeScript = vi
      .fn()
      .mockResolvedValueOnce([{ result: undefined }])
      .mockResolvedValueOnce([
        {
          error: {
            message:
              "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source",
          },
        },
      ]);

    await mod.injectScriptTool.execute({
      tabId: 9,
      type: 'MAIN' as any,
      jsScript: 'x',
    });

    const list = await mod.listInjectedScriptsTool.execute({ tabId: 9 });
    const body = parse((list.content[0] as any).text);
    // Pre-fix this would have shown `count: 1` even though no script ran.
    expect(body.count).toBe(0);
  });

  it('still returns {injected:true, success:true} on happy path', async () => {
    const mod = await loadModule();

    (globalThis.chrome as any).scripting.executeScript = vi
      .fn()
      // bridge inject
      .mockResolvedValueOnce([{ result: undefined }])
      // MAIN-world inject
      .mockResolvedValueOnce([{ result: undefined }])
      // verify — sentinel present means the wrapper actually ran
      .mockResolvedValueOnce([{ result: true }]);

    const res = await mod.injectScriptTool.execute({
      tabId: 10,
      type: 'MAIN' as any,
      jsScript: 'document.title',
    });

    expect(res.isError).toBe(false);
    const body = parse((res.content[0] as any).text);
    expect(body.injected).toBe(true);
    expect(body.success).toBe(true);
  });

  it('flags silent CSP drop (wrapper never ran, no result.error) as CSP_BLOCKED', async () => {
    // LinkedIn's `script-src 'strict-dynamic'` makes chrome.scripting
    // resolve with no error AND no sentinel set. Reproduces the bug
    // #217 false-positive that used to return {injected:true} despite
    // the user code never executing.
    const mod = await loadModule();

    (globalThis.chrome as any).scripting.executeScript = vi
      .fn()
      // bridge inject ok
      .mockResolvedValueOnce([{ result: undefined }])
      // MAIN-world inject — "successful" but the function body never ran
      .mockResolvedValueOnce([{ result: undefined }])
      // verify read — sentinel missing
      .mockResolvedValueOnce([{ result: false }]);

    const res = await mod.injectScriptTool.execute({
      tabId: 12,
      type: 'MAIN' as any,
      jsScript: 'console.log("blocked")',
    });

    expect(res.isError).toBe(true);
    const body = parse((res.content[0] as any).text);
    expect(body.error.code).toBe('INJECTION_FAILED');
    expect(body.error.details.reason).toBe('CSP_BLOCKED');
    expect(body.error.message).toMatch(/MAIN-world script did not execute/);
  });

  it('happy path also verifies the sentinel before claiming success', async () => {
    const mod = await loadModule();

    (globalThis.chrome as any).scripting.executeScript = vi
      .fn()
      // bridge inject ok
      .mockResolvedValueOnce([{ result: undefined }])
      // MAIN-world inject — function ran, no error
      .mockResolvedValueOnce([{ result: undefined }])
      // verify read — sentinel present
      .mockResolvedValueOnce([{ result: true }]);

    const res = await mod.injectScriptTool.execute({
      tabId: 13,
      type: 'MAIN' as any,
      jsScript: 'document.title',
    });

    expect(res.isError).toBe(false);
    const body = parse((res.content[0] as any).text);
    expect(body.injected).toBe(true);
  });

  it('ISOLATED-world path also surfaces per-frame errors', async () => {
    const mod = await loadModule();

    (globalThis.chrome as any).scripting.executeScript = vi
      .fn()
      .mockResolvedValueOnce([{ error: { message: 'ReferenceError: bar is not defined' } }]);

    const res = await mod.injectScriptTool.execute({
      tabId: 11,
      type: 'ISOLATED' as any,
      jsScript: 'bar()',
    });

    expect(res.isError).toBe(true);
    const body = parse((res.content[0] as any).text);
    expect(body.error.details.reason).toBe('INJECTION_ERROR');
  });
});
