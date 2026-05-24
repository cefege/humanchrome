/**
 * chrome_get_attributes tests (IMP-0126).
 *
 * Tool-level coverage: arg validation (mutex selector|ref), default
 * attribute/property sets when arrays are omitted, multi-match behavior
 * (strict guard + index + multi:true), computedStyles opt-in, structured
 * selector resolution path, shim-failure passthrough, TAB_CLOSED
 * classification. Shim itself is exercised via executeScript stub
 * returning canned ShimResult values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAttributesTool } from '@/entrypoints/background/tools/browser/get-attributes';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const TEST_CLIENT = 'get-attrs-test-client';
const TAB_ID = 7;

let executeScriptMock: ReturnType<typeof vi.fn>;

function exec(args: any): Promise<any> {
  return runWithContext({ clientId: TEST_CLIENT }, () => getAttributesTool.execute(args));
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

describe('chrome_get_attributes — validation', () => {
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

describe('chrome_get_attributes — happy paths', () => {
  it('forwards default attributes + properties to the shim when arrays omitted', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: true,
          resolution: 'selector',
          count: 1,
          entries: [
            {
              tagName: 'a',
              attributes: { id: 'a1', class: 'profile', href: '/x', src: null, value: null, title: null, role: null, 'aria-label': 'Profile' },
              properties: { tagName: 'A', checked: undefined, disabled: false, selected: undefined, value: '' },
              computedStyles: {},
            },
          ],
        },
      },
    ]);

    const res = await exec({ selector: 'a.profile' });
    expect(res.isError).toBe(false);
    const [opts] = executeScriptMock.mock.calls[0];
    const [, , attributes, properties, computedStyles] = opts.args;
    expect(attributes).toEqual([
      'id',
      'class',
      'href',
      'src',
      'value',
      'title',
      'role',
      'aria-label',
    ]);
    expect(properties).toEqual(['tagName', 'checked', 'disabled', 'selected', 'value']);
    expect(computedStyles).toEqual([]);

    const body = parseBody(res);
    expect(body.tagName).toBe('a');
    expect(body.attributes.href).toBe('/x');
    expect(body.attributes['aria-label']).toBe('Profile');
  });

  it('empty arrays opt out of those groups', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: true,
          resolution: 'selector',
          count: 1,
          entries: [{ tagName: 'div', attributes: {}, properties: {}, computedStyles: {} }],
        },
      },
    ]);
    await exec({ selector: '#x', attributes: [], properties: [] });
    const [opts] = executeScriptMock.mock.calls[0];
    const [, , attributes, properties] = opts.args;
    expect(attributes).toEqual([]);
    expect(properties).toEqual([]);
  });

  it('computedStyles opt-in is forwarded verbatim', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: true,
          resolution: 'selector',
          count: 1,
          entries: [
            {
              tagName: 'span',
              attributes: { id: 'x', class: null, href: null, src: null, value: null, title: null, role: null, 'aria-label': null },
              properties: { tagName: 'SPAN', checked: undefined, disabled: false, selected: undefined, value: undefined },
              computedStyles: { color: 'rgb(255, 0, 0)', 'font-size': '14px' },
            },
          ],
        },
      },
    ]);
    const res = await exec({ selector: '#x', computedStyles: ['color', 'font-size'] });
    const [opts] = executeScriptMock.mock.calls[0];
    expect(opts.args[4]).toEqual(['color', 'font-size']);

    const body = parseBody(res);
    expect(body.computedStyles.color).toBe('rgb(255, 0, 0)');
    expect(body.computedStyles['font-size']).toBe('14px');
  });

  it('multi:true returns array under matches', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: true,
          resolution: 'selector',
          count: 3,
          entries: [
            { tagName: 'li', attributes: { id: 'a' }, properties: {}, computedStyles: {} },
            { tagName: 'li', attributes: { id: 'b' }, properties: {}, computedStyles: {} },
            { tagName: 'li', attributes: { id: 'c' }, properties: {}, computedStyles: {} },
          ],
        },
      },
    ]);
    const res = await exec({ selector: 'li.row', multi: true });
    const body = parseBody(res);
    expect(body.multi).toBe(true);
    expect(body.count).toBe(3);
    expect(body.matches.map((e: any) => e.attributes.id)).toEqual(['a', 'b', 'c']);
  });

  it('ref path skips selector resolution and passes ref through', async () => {
    executeScriptMock.mockResolvedValueOnce([
      {
        result: {
          ok: true,
          resolution: 'ref',
          count: 1,
          entries: [
            { tagName: 'input', attributes: {}, properties: { value: 'hi' }, computedStyles: {} },
          ],
        },
      },
    ]);
    const res = await exec({ ref: 'ref_42' });
    const [opts] = executeScriptMock.mock.calls[0];
    expect(opts.args[0]).toBeNull(); // selector
    expect(opts.args[1]).toBe('ref_42'); // ref
    expect(parseBody(res).properties.value).toBe('hi');
  });
});

describe('chrome_get_attributes — errors', () => {
  it('surfaces shim ok:false as UNKNOWN', async () => {
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
