/**
 * chrome_hover tests (IMP-0125).
 *
 * Covers arg validation, the shim payload + executeScript wiring (shim
 * runs canned via mock), NOT_ACTIONABLE classification, position offset
 * forwarding, force flag plumbing, and TAB_CLOSED classification.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hoverTool } from '@/entrypoints/background/tools/browser/hover';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const TEST_CLIENT = 'hover-test-client';
const TAB_ID = 7;

let executeScriptMock: ReturnType<typeof vi.fn>;

function exec(args: any): Promise<any> {
  return runWithContext({ clientId: TEST_CLIENT }, () => hoverTool.execute(args));
}
function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  _resetClientStateForTests();
  executeScriptMock = vi.fn();
  (globalThis.chrome as any) = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
      onRemoved: { addListener: () => undefined },
    },
    scripting: { executeScript: executeScriptMock },
    windows: { onRemoved: { addListener: () => undefined } },
    runtime: { lastError: undefined },
  };
  claimTabForClient(TEST_CLIENT, TAB_ID, 1);
});

afterEach(() => {
  _resetClientStateForTests();
});

describe('chrome_hover — validation', () => {
  it('rejects when neither selector nor ref is supplied', async () => {
    const res = await exec({});
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('selector|ref');
  });

  it('rejects when both selector and ref are supplied', async () => {
    const res = await exec({ selector: '#a', ref: 'r1' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('selector|ref');
  });
});

describe('chrome_hover — happy paths', () => {
  it('reports hovered:true with bbox + point on success', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: true,
          hovered: true,
          resolution: 'selector',
          tagName: 'button',
          bbox: { x: 10, y: 20, width: 100, height: 30 },
          point: { x: 60, y: 35 },
        },
      },
    ]);
    const res = await exec({ selector: '#preview' });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.hovered).toBe(true);
    expect(body.tagName).toBe('button');
    expect(body.bbox).toEqual({ x: 10, y: 20, width: 100, height: 30 });
    expect(body.point).toEqual({ x: 60, y: 35 });
  });

  it('forwards position offset to the shim args', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: true,
          hovered: true,
          resolution: 'selector',
          tagName: 'div',
          bbox: { x: 0, y: 0, width: 200, height: 50 },
          point: { x: 5, y: 10 },
        },
      },
    ]);
    await exec({ selector: '#x', position: { x: 5, y: 10 } });
    const [opts] = executeScriptMock.mock.calls[0];
    expect(opts.args[2]).toEqual({ x: 5, y: 10 });
  });

  it('passes force=true through to the shim', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: true,
          hovered: true,
          resolution: 'ref',
          tagName: 'a',
          bbox: { x: 0, y: 0, width: 50, height: 20 },
          point: { x: 25, y: 10 },
        },
      },
    ]);
    await exec({ ref: 'ref_9', force: true });
    const [opts] = executeScriptMock.mock.calls[0];
    expect(opts.args[3]).toBe(true);
  });
});

describe('chrome_hover — errors', () => {
  it('shim notActionable:true → NOT_ACTIONABLE with failures', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: false,
          message: 'element is not actionable: not_visible',
          notActionable: true,
          failures: ['not_visible'],
        },
      },
    ]);
    const res = await exec({ selector: '#hidden' });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text as string;
    expect(text).toContain('NOT_ACTIONABLE');
    const body = JSON.parse(text);
    expect(body.error.details.failures).toEqual(['not_visible']);
  });

  it('shim occluded_by:<tag> classifies as NOT_ACTIONABLE', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: false,
          message: 'element is occluded by div#overlay',
          notActionable: true,
          failures: ['occluded_by:div#overlay'],
        },
      },
    ]);
    const res = await exec({ selector: '#target' });
    expect(res.isError).toBe(true);
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.error.details.failures[0]).toMatch(/^occluded_by:/);
  });

  it('shim ok:false without notActionable → UNKNOWN', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: false, message: 'selector "#nope" matched no element' } },
    ]);
    const res = await exec({ selector: '#nope' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('matched no element');
  });

  it('returns UNKNOWN when the shim returns no result (frame missing)', async () => {
    executeScriptMock.mockResolvedValueOnce([]);
    const res = await exec({ selector: '#x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('no result');
  });

  it('classifies "No tab with id" rejection as TAB_CLOSED', async () => {
    executeScriptMock.mockRejectedValueOnce(new Error('No tab with id: 7'));
    const res = await exec({ selector: '#x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_CLOSED');
  });
});
