/**
 * chrome_select_text tests.
 *
 * Wraps chrome.scripting.executeScript with an ISOLATED-world shim. Tests
 * stub executeScript and assert the contract; in-page DOM walking is
 * exercised indirectly via canned shim responses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { selectTextTool } from '@/entrypoints/background/tools/browser/select-text';

let executeScriptMock: ReturnType<typeof vi.fn>;
let queryMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  executeScriptMock = vi.fn().mockResolvedValue([
    {
      result: {
        ok: true,
        resolution: 'selector',
        mode: 'input-range',
        start: 0,
        end: 5,
        selected: 'hello',
        tagName: 'input',
      },
    },
  ]);
  queryMock = vi.fn().mockResolvedValue([{ id: 7 }]);
  (globalThis.chrome as any).scripting = { executeScript: executeScriptMock };
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    query: queryMock,
  };
});

afterEach(() => {
  // shared chrome.* — leave in place
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_select_text: arg validation', () => {
  it('rejects when neither selector nor ref is supplied', async () => {
    const res = await selectTextTool.execute({ substring: 'x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('selector|ref');
  });

  it('rejects when both selector and ref are supplied', async () => {
    const res = await selectTextTool.execute({ selector: 'input', ref: 'r1', substring: 'x' });
    expect(res.isError).toBe(true);
  });

  it('rejects when neither substring nor start+end is supplied', async () => {
    const res = await selectTextTool.execute({ selector: 'input' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('substring|start+end');
  });

  it('rejects when both substring and start+end are supplied', async () => {
    const res = await selectTextTool.execute({
      selector: 'input',
      substring: 'x',
      start: 0,
      end: 1,
    });
    expect(res.isError).toBe(true);
  });

  it('rejects when start > end', async () => {
    const res = await selectTextTool.execute({ selector: 'input', start: 5, end: 2 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('start');
  });
});

describe('chrome_select_text: happy path', () => {
  it('forwards substring + selector via the shim args', async () => {
    await selectTextTool.execute({ tabId: 7, selector: '#name', substring: 'Bob' });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7 },
        world: 'ISOLATED',
        args: ['#name', null, 'Bob', null, null],
      }),
    );
  });

  it('forwards start+end via the shim args', async () => {
    await selectTextTool.execute({ tabId: 7, ref: 'r-9', start: 2, end: 7 });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ args: [null, 'r-9', null, 2, 7] }),
    );
  });

  it('returns the input-range mode and selected substring', async () => {
    const body = parseBody(
      await selectTextTool.execute({ tabId: 7, selector: 'input', substring: 'hello' }),
    );
    expect(body.mode).toBe('input-range');
    expect(body.selected).toBe('hello');
    expect(body.start).toBe(0);
    expect(body.end).toBe(5);
  });

  it('returns the dom-range mode for non-input elements', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: true,
          resolution: 'selector',
          mode: 'dom-range',
          start: 4,
          end: 9,
          selected: 'world',
          tagName: 'div',
        },
      },
    ]);
    const body = parseBody(
      await selectTextTool.execute({ tabId: 7, selector: 'div.body', substring: 'world' }),
    );
    expect(body.mode).toBe('dom-range');
    expect(body.tagName).toBe('div');
  });

  it('falls back to the active tab when no tabId is provided', async () => {
    await selectTextTool.execute({ selector: 'input', substring: 'a' });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 } }),
    );
  });

  it('forwards frameId when supplied', async () => {
    await selectTextTool.execute({ tabId: 7, selector: 'input', substring: 'a', frameId: 11 });
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7, frameIds: [11] } }),
    );
  });
});

describe('chrome_select_text: error classification', () => {
  it('classifies "substring not found" as INVALID_ARGS', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: false, message: 'substring "zzz" not found in input value' } },
    ]);
    const res = await selectTextTool.execute({ tabId: 7, selector: 'input', substring: 'zzz' });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toContain('INVALID_ARGS');
    expect(text).toContain('substring');
  });

  it('classifies generic shim ok:false as UNKNOWN', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: false, message: 'window.getSelection() returned null' } },
    ]);
    const res = await selectTextTool.execute({
      tabId: 7,
      selector: 'div',
      start: 0,
      end: 1,
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('UNKNOWN');
  });

  it('classifies "no tab with id" as TAB_CLOSED', async () => {
    executeScriptMock.mockRejectedValueOnce(new Error('No tab with id: 99'));
    const res = await selectTextTool.execute({ tabId: 99, selector: 'input', substring: 'x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_CLOSED');
  });

  it('returns TAB_NOT_FOUND when there is no active tab', async () => {
    queryMock.mockResolvedValueOnce([]);
    const res = await selectTextTool.execute({ selector: 'input', substring: 'x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_NOT_FOUND');
  });

  it('returns an error when the shim returns no result', async () => {
    executeScriptMock.mockResolvedValueOnce([]);
    const res = await selectTextTool.execute({ tabId: 7, selector: 'input', substring: 'x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('no result');
  });
});
