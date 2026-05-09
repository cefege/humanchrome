import { describe, test, expect, jest, beforeEach } from '@jest/globals';

// Mock the native-messaging-host singleton BEFORE importing dispatch — the
// module resolves the import as `.default`, so the mock exposes the instance
// at the same key.
const sendRequestToExtensionAndWait = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../native-messaging-host', () => ({
  __esModule: true,
  default: {
    sendRequestToExtensionAndWait,
    newRequestId: () => 'test-request-id',
  },
}));

import {
  listDynamicFlowTools,
  FLOW_RUNNER_RESERVED_KEYS,
  invalidateFlowToolsCache,
} from './dispatch';

beforeEach(() => {
  sendRequestToExtensionAndWait.mockReset();
  // The flow-tools cache is module-scoped and shared across tests; wipe
  // it so each case sees a fresh fetch routed through its own mock.
  invalidateFlowToolsCache();
});

// Keys advertised in the schema (injected by listDynamicFlowTools after the
// user-var loop). `startUrl` is reserved at call time but NOT advertised.
const SCHEMA_RUNNER_KEYS = [
  'tabTarget',
  'refresh',
  'captureNetwork',
  'returnLogs',
  'timeoutMs',
] as const;

function flowListResponse(items: any[]) {
  return { status: 'success', items };
}

describe('listDynamicFlowTools — runner-option key collisions', () => {
  test('FLOW_RUNNER_RESERVED_KEYS mirrors buildFlowArgs (six keys including startUrl)', () => {
    expect(FLOW_RUNNER_RESERVED_KEYS.size).toBe(6);
    for (const k of [...SCHEMA_RUNNER_KEYS, 'startUrl']) {
      expect(FLOW_RUNNER_RESERVED_KEYS.has(k)).toBe(true);
    }
  });

  test('a user var named `timeoutMs` is dropped from the schema; runner-option shape wins', async () => {
    sendRequestToExtensionAndWait.mockResolvedValue(
      flowListResponse([
        {
          id: 'flow_1',
          slug: 'timer-flow',
          variables: [
            { key: 'timeoutMs', label: 'My custom timeout', type: 'number', default: 5000 },
            { key: 'query', label: 'Search term', type: 'string' },
          ],
        },
      ]),
    );

    const tools = await listDynamicFlowTools();
    expect(tools).toHaveLength(1);
    const props = (tools[0].inputSchema as any).properties as Record<string, any>;

    expect(props.timeoutMs).toEqual({ type: 'number', minimum: 0 });
    expect(props.query).toEqual({ description: 'Search term', type: 'string' });
  });

  test('a user var named `startUrl` is dropped and NOT re-injected (reserved at call time only)', async () => {
    sendRequestToExtensionAndWait.mockResolvedValue(
      flowListResponse([
        {
          id: 'flow_startUrl',
          slug: 'start-url-flow',
          variables: [
            { key: 'startUrl', label: 'Custom landing', type: 'string', default: '/' },
            { key: 'query', label: 'Search term', type: 'string' },
          ],
        },
      ]),
    );

    const tools = await listDynamicFlowTools();
    const props = (tools[0].inputSchema as any).properties as Record<string, any>;

    expect(props).not.toHaveProperty('startUrl');
    expect(props.query).toEqual({ description: 'Search term', type: 'string' });
  });

  test('a user var named `timeoutMs` marked required does NOT end up in the required array', async () => {
    sendRequestToExtensionAndWait.mockResolvedValue(
      flowListResponse([
        {
          id: 'flow_2',
          slug: 'required-collision',
          variables: [
            {
              key: 'timeoutMs',
              type: 'number',
              rules: { required: true },
            },
            { key: 'query', type: 'string', rules: { required: true } },
          ],
        },
      ]),
    );

    const tools = await listDynamicFlowTools();
    const required = (tools[0].inputSchema as any).required as string[];
    expect(required).toEqual(['query']);
  });

  test('all schema-injected runner keys are reserved simultaneously when colliding user vars are present', async () => {
    sendRequestToExtensionAndWait.mockResolvedValue(
      flowListResponse([
        {
          id: 'flow_3',
          slug: 'all-collide',
          variables: SCHEMA_RUNNER_KEYS.map((k) => ({
            key: k,
            label: `should be hidden: ${k}`,
            type: 'string',
          })),
        },
      ]),
    );

    const tools = await listDynamicFlowTools();
    const props = (tools[0].inputSchema as any).properties as Record<string, any>;

    expect(props.tabTarget).toEqual({
      type: 'string',
      enum: ['current', 'new'],
      default: 'current',
    });
    expect(props.refresh).toEqual({ type: 'boolean', default: false });
    expect(props.captureNetwork).toEqual({ type: 'boolean', default: false });
    expect(props.returnLogs).toEqual({ type: 'boolean', default: false });
    expect(props.timeoutMs).toEqual({ type: 'number', minimum: 0 });
    for (const k of SCHEMA_RUNNER_KEYS) {
      expect(props[k]).not.toHaveProperty('description');
    }
  });

  test('a flow with NO collisions keeps user vars intact alongside runner options', async () => {
    sendRequestToExtensionAndWait.mockResolvedValue(
      flowListResponse([
        {
          id: 'flow_4',
          slug: 'clean-flow',
          variables: [
            { key: 'customNum', label: 'My number', type: 'number', default: 7 },
            { key: 'name', label: 'Name', type: 'string' },
          ],
        },
      ]),
    );

    const tools = await listDynamicFlowTools();
    const props = (tools[0].inputSchema as any).properties as Record<string, any>;
    expect(props.customNum).toEqual({ description: 'My number', type: 'number', default: 7 });
    expect(props.name).toEqual({ description: 'Name', type: 'string' });
    // Runner options still injected, of course.
    expect(props.timeoutMs).toEqual({ type: 'number', minimum: 0 });
  });
});
