/**
 * IMP-0179 — contract test for the dispatcher's universal output budget.
 *
 * The dispatcher (`tools/index.ts`) wraps every successful tool result
 * through `enforceOutputBudget` (from packages/shared). This test installs
 * a fake tool whose `execute()` returns a payload larger than the default
 * cap, dispatches through `handleCallTool`, and asserts:
 *
 *   1. The result is truncated by default.
 *   2. The truncation envelope carries `{truncated, originalSize, limit, unit:'bytes', hint}`.
 *   3. Passing `raw: true` in args bypasses the cap.
 *   4. Per-tool `static outputBudgetBytes` overrides the default.
 *   5. Error results bypass the cap.
 *
 * Lives at the dispatcher level so it covers every tool by construction —
 * no need to repeat per-tool. Per-tool truncation envelopes
 * (network-capture's `responseBodyTruncation`, userscript's
 * `maxOutputBytes`, console's `truncation`) remain authoritative for their
 * structured fields — those are inner guards, this is the outer guard.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  handleCallTool,
  _registerToolForTest,
  _unregisterToolForTest,
} from '@/entrypoints/background/tools';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';

class GiantTextTool extends BaseBrowserToolExecutor {
  name = '__test_giant_text';
  static readonly mutates = false;
  static readonly autoSpawnTab = false;
  async execute(args: { size?: number; isError?: boolean }): Promise<any> {
    const size = args?.size ?? 60_000;
    return {
      content: [{ type: 'text', text: 'a'.repeat(size) }],
      isError: args?.isError === true,
    };
  }
}

class GiantTextWithOverrideTool extends BaseBrowserToolExecutor {
  name = '__test_giant_override';
  static readonly mutates = false;
  static readonly autoSpawnTab = false;
  static readonly outputBudgetBytes = 4096;
  async execute(): Promise<any> {
    return {
      content: [{ type: 'text', text: 'b'.repeat(10_000) }],
      isError: false,
    };
  }
}

const giantTool = new GiantTextTool();
const giantOverrideTool = new GiantTextWithOverrideTool();

beforeEach(() => {
  (globalThis.chrome as any).tabs = {
    query: async () => [],
    get: async () => undefined,
  };
  _registerToolForTest(giantTool);
  _registerToolForTest(giantOverrideTool);
});

afterEach(() => {
  _unregisterToolForTest(giantTool.name);
  _unregisterToolForTest(giantOverrideTool.name);
});

describe('IMP-0179 dispatcher output budget', () => {
  it('caps oversized results by default and surfaces truncation metadata', async () => {
    const result: any = await handleCallTool({ name: giantTool.name, args: {} });
    expect(result.isError).toBeFalsy();
    expect(result.truncation?.truncated).toBe(true);
    expect(result.truncation?.unit).toBe('bytes');
    expect(result.truncation?.originalSize).toBeGreaterThan(result.truncation?.limit);
    expect(result.truncation?.hint).toContain('raw=true');
    const txt = result.content[0].text;
    expect(txt.length).toBeLessThan(60_000);
    expect(txt).toContain('[Result truncated by dispatcher');
  });

  it('passes through small results unchanged', async () => {
    const result: any = await handleCallTool({ name: giantTool.name, args: { size: 100 } });
    expect(result.isError).toBeFalsy();
    expect(result.truncation).toBeUndefined();
    expect(result.content[0].text.length).toBe(100);
  });

  it('honors raw=true to bypass the cap', async () => {
    const result: any = await handleCallTool({
      name: giantTool.name,
      args: { raw: true, size: 60_000 },
    });
    expect(result.truncation).toBeUndefined();
    expect(result.content[0].text.length).toBe(60_000);
  });

  it('honors per-tool outputBudgetBytes override', async () => {
    const result: any = await handleCallTool({
      name: giantOverrideTool.name,
      args: {},
    });
    expect(result.truncation?.truncated).toBe(true);
    expect(result.truncation?.limit).toBe(4096);
  });

  it('does not truncate error results', async () => {
    const result: any = await handleCallTool({
      name: giantTool.name,
      args: { isError: true, size: 60_000 },
    });
    expect(result.isError).toBe(true);
    expect(result.truncation).toBeUndefined();
    expect(result.content[0].text.length).toBe(60_000);
  });
});
