/**
 * Flow-tools cache tests (IMP-0058).
 *
 * Pre-cache: every `tools/list` AND every `flow.<slug>` dispatch did a
 * fresh `rr_list_published_flows` round-trip — so a single tools/list
 * immediately followed by a flow.<slug> call cost two 20s-timeout
 * native-messaging round-trips. With the cache, both share one fetch
 * within the 60s TTL.
 *
 * The mocked native-messaging-host counts how many times
 * `rr_list_published_flows` is called and decides what each one returns,
 * so each test pins a precise round-trip count for its scenario.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';

const sendRequestToExtensionAndWait = jest.fn<(...args: any[]) => Promise<any>>();

jest.mock('../native-messaging-host', () => ({
  __esModule: true,
  default: {
    sendRequestToExtensionAndWait,
    newRequestId: () => 'test-request-id',
  },
}));

import { listDynamicFlowTools, dispatchTool, invalidateFlowToolsCache } from './dispatch';

const SAMPLE_ITEMS = [
  {
    id: 'flow_1',
    slug: 'demo',
    description: 'Demo flow',
    variables: [{ key: 'query', label: 'Query', type: 'string' }],
  },
  {
    id: 'flow_2',
    slug: 'other',
    description: 'Other flow',
    variables: [],
  },
];

function listResponse(items: any[] = SAMPLE_ITEMS) {
  return { status: 'success', items };
}

/**
 * Count the rr_list_published_flows calls only — there are also CALL_TOOL
 * calls in the dispatch path that we don't want to count.
 */
function countListCalls(): number {
  return sendRequestToExtensionAndWait.mock.calls.filter((c) => c[1] === 'rr_list_published_flows')
    .length;
}

beforeEach(() => {
  sendRequestToExtensionAndWait.mockReset();
  invalidateFlowToolsCache();
});

describe('listDynamicFlowTools — caching', () => {
  test('repeated calls within the TTL share a single fetch', async () => {
    sendRequestToExtensionAndWait.mockResolvedValue(listResponse());

    const a = await listDynamicFlowTools();
    const b = await listDynamicFlowTools();
    const c = await listDynamicFlowTools();

    expect(countListCalls()).toBe(1);
    expect(a).toHaveLength(2);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test('concurrent calls during a cold fetch collapse onto one in-flight request', async () => {
    let resolveFetch: (v: any) => void = () => {};
    sendRequestToExtensionAndWait.mockImplementationOnce(
      () => new Promise((r) => (resolveFetch = r)),
    );

    const inflight = Promise.all([
      listDynamicFlowTools(),
      listDynamicFlowTools(),
      listDynamicFlowTools(),
    ]);
    // All three should be parked on the same pending fetch.
    expect(countListCalls()).toBe(1);

    resolveFetch(listResponse());
    const results = await inflight;
    expect(results[0]).toHaveLength(2);
    expect(results.every((t) => t === results[0])).toBe(true);
    expect(countListCalls()).toBe(1);
  });

  test('a fetch error returns empty without poisoning the cache (next call retries)', async () => {
    sendRequestToExtensionAndWait
      .mockRejectedValueOnce(new Error('native messaging timeout'))
      .mockResolvedValueOnce(listResponse());

    const first = await listDynamicFlowTools();
    expect(first).toEqual([]);

    const second = await listDynamicFlowTools();
    expect(second).toHaveLength(2);

    expect(countListCalls()).toBe(2);
  });

  test('invalidateFlowToolsCache forces the next call to refetch', async () => {
    sendRequestToExtensionAndWait
      .mockResolvedValueOnce(listResponse(SAMPLE_ITEMS))
      .mockResolvedValueOnce(listResponse([SAMPLE_ITEMS[0]]));

    const before = await listDynamicFlowTools();
    expect(before).toHaveLength(2);

    invalidateFlowToolsCache();

    const after = await listDynamicFlowTools();
    expect(after).toHaveLength(1);

    expect(countListCalls()).toBe(2);
  });
});

describe('dispatchTool flow.<slug> — cache reuse with tools/list', () => {
  test('IMP-0058 acceptance: tools/list followed by flow.<slug> only triggers ONE rr_list_published_flows', async () => {
    // First call from listDynamicFlowTools fills the cache; the flow.demo
    // call below should reuse the cached items and never refetch the list.
    sendRequestToExtensionAndWait.mockImplementation((payload: any, kind: any) => {
      if (kind === 'rr_list_published_flows') {
        return Promise.resolve(listResponse());
      }
      // CALL_TOOL for the flow run
      return Promise.resolve({
        status: 'success',
        data: { content: [{ type: 'text', text: '{"ok":true}' }], isError: false },
      });
    });

    await listDynamicFlowTools();
    expect(countListCalls()).toBe(1);

    const result = await dispatchTool('flow.demo', { query: 'hello' });
    expect(result.isError).toBeFalsy();

    expect(countListCalls()).toBe(1);
  });

  test('flow.<slug> with cold cache fetches once and reuses for a subsequent flow call', async () => {
    sendRequestToExtensionAndWait.mockImplementation((_payload: any, kind: any) => {
      if (kind === 'rr_list_published_flows') {
        return Promise.resolve(listResponse());
      }
      return Promise.resolve({
        status: 'success',
        data: { content: [{ type: 'text', text: '{"ok":true}' }], isError: false },
      });
    });

    await dispatchTool('flow.demo', { query: 'a' });
    await dispatchTool('flow.other', {});
    await dispatchTool('flow.demo', { query: 'b' });

    expect(countListCalls()).toBe(1);
  });

  test('an unknown flow.<slug> triggers a single refetch attempt before failing', async () => {
    // First call returns SAMPLE_ITEMS (no `unknown-slug` in there). The
    // dispatch path then invalidates and refetches once. Second call
    // still returns SAMPLE_ITEMS, so dispatch ultimately throws.
    sendRequestToExtensionAndWait.mockImplementation((_payload: any, kind: any) => {
      if (kind === 'rr_list_published_flows') {
        return Promise.resolve(listResponse());
      }
      throw new Error('unreachable: flow not found should fail before CALL_TOOL');
    });

    const result = await dispatchTool('flow.unknown-slug', {});

    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as any).text);
    expect(body.error.message).toMatch(/Flow not found for tool flow\.unknown-slug/);
    expect(countListCalls()).toBe(2);
  });

  test('a flow published after the initial cache becomes callable after the refetch', async () => {
    // First fetch returns just `demo`. A flow.new-flow call comes in;
    // dispatch invalidates and refetches, this time with `new-flow`
    // present, and the call succeeds.
    let nthFetch = 0;
    sendRequestToExtensionAndWait.mockImplementation((_payload: any, kind: any) => {
      if (kind === 'rr_list_published_flows') {
        nthFetch += 1;
        return Promise.resolve(
          nthFetch === 1
            ? listResponse([SAMPLE_ITEMS[0]])
            : listResponse([...SAMPLE_ITEMS, { id: 'flow_3', slug: 'new-flow', variables: [] }]),
        );
      }
      return Promise.resolve({
        status: 'success',
        data: { content: [{ type: 'text', text: '{"ok":true}' }], isError: false },
      });
    });

    const before = await listDynamicFlowTools();
    expect(before.map((t) => t.name)).toEqual(['flow.demo']);

    const result = await dispatchTool('flow.new-flow', {});
    expect(result.isError).toBeFalsy();

    expect(countListCalls()).toBe(2);
  });
});
