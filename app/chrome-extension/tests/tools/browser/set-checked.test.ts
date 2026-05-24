/**
 * chrome_set_checked tests (IMP-0146).
 *
 * Covers arg validation, shim dispatch wiring, NOT_ACTIONABLE +
 * INVALID_ARGS + UNKNOWN classifications, and the {changed,
 * priorChecked, checked} envelope shape. Shim itself runs canned via
 * executeScript mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setCheckedTool } from '@/entrypoints/background/tools/browser/set-checked';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const TEST_CLIENT = 'set-checked-test-client';
const TAB_ID = 7;

let executeScriptMock: ReturnType<typeof vi.fn>;

function exec(args: any): Promise<any> {
  return runWithContext({ clientId: TEST_CLIENT }, () => setCheckedTool.execute(args));
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

describe('chrome_set_checked — validation', () => {
  it('rejects missing checked', async () => {
    const res = await exec({ selector: '#x' });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('checked');
  });

  it('rejects non-boolean checked', async () => {
    const res = await exec({ selector: '#x', checked: 'true' as any });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('checked');
  });

  it('rejects mutex selector|ref', async () => {
    const res = await exec({ selector: '#x', ref: 'r1', checked: true });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('selector|ref');
  });

  it('rejects neither selector nor ref', async () => {
    const res = await exec({ checked: true });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.details?.arg).toBe('selector|ref');
  });
});

describe('chrome_set_checked — happy paths', () => {
  it('returns changed:true with priorChecked:false when flipping on', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: true,
          changed: true,
          priorChecked: false,
          checked: true,
          tagName: 'input',
          role: null,
          resolution: 'selector',
        },
      },
    ]);
    const res = await exec({ selector: '#agree', checked: true });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.changed).toBe(true);
    expect(body.priorChecked).toBe(false);
    expect(body.checked).toBe(true);
  });

  it('idempotent — returns changed:false when already in target state', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: true,
          changed: false,
          priorChecked: true,
          checked: true,
          tagName: 'input',
          role: null,
          resolution: 'selector',
        },
      },
    ]);
    const res = await exec({ selector: '#agree', checked: true });
    const body = parseBody(res);
    expect(body.changed).toBe(false);
    expect(body.priorChecked).toBe(true);
    expect(body.checked).toBe(true);
  });

  it('ARIA role=switch path returns role in envelope', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: true,
          changed: true,
          priorChecked: false,
          checked: true,
          tagName: 'div',
          role: 'switch',
          resolution: 'selector',
        },
      },
    ]);
    const res = await exec({ selector: '[role=switch]', checked: true });
    const body = parseBody(res);
    expect(body.tagName).toBe('div');
    expect(body.role).toBe('switch');
  });

  it('forwards checked + force to the shim args', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: true, changed: false, priorChecked: false, checked: false, tagName: 'input', role: null, resolution: 'selector' } },
    ]);
    await exec({ selector: '#x', checked: false, force: true });
    const [opts] = executeScriptMock.mock.calls[0];
    expect(opts.args[2]).toBe(false); // wantChecked
    expect(opts.args[3]).toBe(true); // force
  });
});

describe('chrome_set_checked — errors', () => {
  it('shim invalidTarget → INVALID_ARGS with tagName + role', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: false,
          message: 'element <div> is not checkable',
          invalidTarget: { tagName: 'div', role: null },
        },
      },
    ]);
    const res = await exec({ selector: '#wrong', checked: true });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.code).toBe('INVALID_ARGS');
    expect(body.error.details.tagName).toBe('div');
  });

  it('shim notActionable:disabled → NOT_ACTIONABLE', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: false,
          message: 'element is disabled',
          notActionable: true,
          failures: ['disabled'],
        },
      },
    ]);
    const res = await exec({ selector: '#x', checked: true });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error.code).toBe('NOT_ACTIONABLE');
    expect(body.error.details.failures).toEqual(['disabled']);
  });

  it('shim ok:false sans classification → UNKNOWN', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: false, message: 'click did not flip state' } },
    ]);
    const res = await exec({ selector: '#x', checked: true });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('did not flip');
  });

  it('returns UNKNOWN when shim returns no result (frame missing)', async () => {
    executeScriptMock.mockResolvedValueOnce([]);
    const res = await exec({ selector: '#x', checked: true });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('no result');
  });

  it('classifies "No tab with id" via classifyTabError → TAB_CLOSED', async () => {
    executeScriptMock.mockRejectedValueOnce(new Error('No tab with id: 7'));
    const res = await exec({ selector: '#x', checked: true });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_CLOSED');
  });
});
