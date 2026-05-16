/**
 * chrome_drag_drop tests.
 *
 * Synthesizes a drag-and-drop sequence between two elements via a MAIN-world
 * shim. Tests stub chrome.scripting.executeScript and assert the contract;
 * in-page event dispatching is exercised indirectly via canned shim
 * responses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dragDropTool } from '@/entrypoints/background/tools/browser/drag-drop';

const SAMPLE_RESULT = {
  ok: true,
  steps: 5,
  fromBox: { x: 10, y: 20, width: 100, height: 30 },
  toBox: { x: 200, y: 300, width: 100, height: 30 },
};

let executeScriptMock: ReturnType<typeof vi.fn>;
let queryMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  executeScriptMock = vi.fn().mockResolvedValue([{ result: SAMPLE_RESULT }]);
  queryMock = vi.fn().mockResolvedValue([{ id: 7 }]);
  (globalThis.chrome as any).scripting = { executeScript: executeScriptMock };
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    query: queryMock,
  };
});

afterEach(() => {
  // chrome.* stays for other tests
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_drag_drop: arg validation', () => {
  it('rejects when neither fromSelector nor fromRef is supplied', async () => {
    const res = await dragDropTool.execute({ toSelector: '.dest' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('fromSelector|fromRef');
  });

  it('rejects when both fromSelector and fromRef are supplied', async () => {
    const res = await dragDropTool.execute({
      fromSelector: '.src',
      fromRef: 'r-1',
      toSelector: '.dst',
    });
    expect(res.isError).toBe(true);
  });

  it('rejects when neither toSelector nor toRef is supplied', async () => {
    const res = await dragDropTool.execute({ fromSelector: '.src' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('toSelector|toRef');
  });

  it('rejects when both toSelector and toRef are supplied', async () => {
    const res = await dragDropTool.execute({
      fromSelector: '.src',
      toSelector: '.dst',
      toRef: 'r-2',
    });
    expect(res.isError).toBe(true);
  });
});

describe('chrome_drag_drop: happy path', () => {
  it('forwards selectors via shim args with default steps=5 + force=false + actionabilityTimeoutMs=5000', async () => {
    await dragDropTool.execute({ tabId: 7, fromSelector: '.src', toSelector: '.dst' });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7 },
        world: 'MAIN',
        // IMP-0097: shim signature gains force + actionabilityTimeoutMs.
        args: ['.src', null, '.dst', null, 5, false, 5000],
      }),
    );
  });

  it('forwards refs via shim args', async () => {
    await dragDropTool.execute({ tabId: 7, fromRef: 'r-1', toRef: 'r-2' });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ args: [null, 'r-1', null, 'r-2', 5, false, 5000] }),
    );
  });

  it('clamps steps to [1, 50]', async () => {
    await dragDropTool.execute({
      tabId: 7,
      fromSelector: '.s',
      toSelector: '.t',
      steps: 100,
    });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['.s', null, '.t', null, 50, false, 5000] }),
    );

    executeScriptMock.mockClear();
    await dragDropTool.execute({
      tabId: 7,
      fromSelector: '.s',
      toSelector: '.t',
      steps: 0,
    });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['.s', null, '.t', null, 1, false, 5000] }),
    );
  });

  it('forwards force=true and a custom actionabilityTimeoutMs', async () => {
    await dragDropTool.execute({
      tabId: 7,
      fromSelector: '.s',
      toSelector: '.t',
      force: true,
      actionabilityTimeoutMs: 12000,
    });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['.s', null, '.t', null, 5, true, 12000] }),
    );
  });

  it('falls back to the active tab when no tabId is provided', async () => {
    await dragDropTool.execute({ fromSelector: '.s', toSelector: '.t' });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 } }),
    );
  });

  it('forwards frameId when supplied', async () => {
    await dragDropTool.execute({
      tabId: 7,
      fromSelector: '.s',
      toSelector: '.t',
      frameId: 11,
    });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7, frameIds: [11] } }),
    );
  });

  it('returns the boxes and step count from the shim', async () => {
    const body = parseBody(
      await dragDropTool.execute({ tabId: 7, fromSelector: '.s', toSelector: '.t' }),
    );
    expect(body.steps).toBe(5);
    expect(body.fromBox.x).toBe(10);
    expect(body.toBox.x).toBe(200);
  });
});

describe('chrome_drag_drop: error classification', () => {
  it('classifies from_not_found as INVALID_ARGS', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: false,
          message: 'from selector ".nope" matched no element',
          reason: 'from_not_found',
        },
      },
    ]);
    const res = await dragDropTool.execute({ tabId: 7, fromSelector: '.nope', toSelector: '.t' });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toContain('INVALID_ARGS');
    expect(text).toContain('matched no element');
  });

  it('classifies to_hidden as INVALID_ARGS', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: { ok: false, message: 'to element is not visible', reason: 'to_hidden' },
      },
    ]);
    const res = await dragDropTool.execute({ tabId: 7, fromSelector: '.s', toSelector: '.t' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('INVALID_ARGS');
  });

  it('classifies from_not_actionable as NOT_ACTIONABLE with failures', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: false,
          message: 'from element is not actionable: occluded_by:div#cookie-banner',
          reason: 'from_not_actionable',
          failures: ['occluded_by:div#cookie-banner'],
        },
      },
    ]);
    const res = await dragDropTool.execute({ tabId: 7, fromSelector: '.s', toSelector: '.t' });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toContain('NOT_ACTIONABLE');
    expect(text).toContain('occluded_by:div#cookie-banner');
    const parsed = JSON.parse(text);
    expect(parsed.error.details.failures).toEqual(['occluded_by:div#cookie-banner']);
  });

  it('classifies to_not_actionable as NOT_ACTIONABLE', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: false,
          message: 'to element is not actionable: unstable_bbox',
          reason: 'to_not_actionable',
          failures: ['unstable_bbox'],
        },
      },
    ]);
    const res = await dragDropTool.execute({ tabId: 7, fromSelector: '.s', toSelector: '.t' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('NOT_ACTIONABLE');
  });

  it('classifies a generic shim ok:false as UNKNOWN', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: false, message: 'DataTransfer constructor not supported', reason: 'other' } },
    ]);
    const res = await dragDropTool.execute({ tabId: 7, fromSelector: '.s', toSelector: '.t' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('UNKNOWN');
  });

  it('classifies "no tab with id" as TAB_CLOSED', async () => {
    executeScriptMock.mockRejectedValueOnce(new Error('No tab with id: 99'));
    const res = await dragDropTool.execute({ tabId: 99, fromSelector: '.s', toSelector: '.t' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_CLOSED');
  });

  it('returns TAB_NOT_FOUND when there is no active tab', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await dragDropTool.execute({ fromSelector: '.s', toSelector: '.t' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_NOT_FOUND');
  });

  it('returns an error when the shim returns no result', async () => {
    executeScriptMock.mockResolvedValueOnce([]);
    const res = await dragDropTool.execute({ tabId: 7, fromSelector: '.s', toSelector: '.t' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('no result');
  });
});
