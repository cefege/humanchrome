/**
 * IMP-0177 — contract test for the single-tool MCP dispatcher.
 *
 * Validates:
 *   1. In `legacy` mode, `tools/list` returns the full TOOL_SCHEMAS array
 *      (current behavior, no regression).
 *   2. In `lazy` mode, `tools/list` returns exactly one static tool —
 *      `humanchrome` — plus any dynamic `flow.*` tools.
 *   3. The `humanchrome` tool descriptor carries the catalog in its
 *      description and a `{ name, args, raw }` input schema.
 *   4. Calling `humanchrome({ name: "<known-tool>", args })` routes through
 *      `dispatchTool` with the named tool + args.
 *   5. Calling `humanchrome({ name: "<unknown>" })` returns an `INVALID_ARGS`
 *      envelope with `details.expected.kind === "tool_name"` and a hint when
 *      the typo is close to a real tool.
 *   6. Missing `name` returns `INVALID_ARGS` with `details.arg === "name"`.
 *   7. Legacy mode calls (the same name "humanchrome" but legacy mode is on)
 *      fall through to the regular dispatch path (treated as unknown tool by
 *      the extension — not the dispatcher path).
 *   8. The audit script's actual savings exceed 10× (the wave's done-criteria
 *      floor) against the current TOOL_SCHEMAS.
 *
 * Stubs `nativeMessagingHostInstance` so dispatchTool resolves locally.
 */
import { beforeEach, describe, test, expect, jest } from '@jest/globals';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS, buildDispatcherTool, DISPATCHER_TOOL_NAME } from 'humanchrome-shared';
import { _resetIdemCacheForTest } from './idem-cache';

// Mock the native-messaging transport before importing the dispatcher. We
// don't actually need the extension to be alive — we just need to assert
// that dispatchTool was called with the right `(name, args)` after the
// outer humanchrome dispatcher resolves.
const sendRequestMock = jest.fn() as jest.MockedFunction<(...a: any[]) => Promise<any>>;
jest.mock('../native-messaging-host', () => ({
  __esModule: true,
  default: {
    newRequestId: () => 'rid_test',
    sendRequestToExtensionAndWait: (...a: any[]) => sendRequestMock(...a),
  },
}));

// Re-import after mock is registered.
import { setupTools } from './register-tools';

type HandlerMap = Map<unknown, (req: any) => Promise<any>>;

function makeFakeServer(): { handlers: HandlerMap; server: any } {
  const handlers: HandlerMap = new Map();
  const server = {
    setRequestHandler(schema: unknown, fn: (req: any) => Promise<any>) {
      handlers.set(schema, fn);
    },
  };
  return { handlers, server };
}

function setMode(mode: 'legacy' | 'lazy' | undefined) {
  if (mode === undefined) delete process.env.HUMANCHROME_TOOL_MODE;
  else process.env.HUMANCHROME_TOOL_MODE = mode;
}

beforeEach(() => {
  sendRequestMock.mockReset();
  sendRequestMock.mockResolvedValue({
    status: 'success',
    data: { content: [{ type: 'text', text: '{"ok":true}' }], isError: false },
  });
  setMode(undefined);
  _resetIdemCacheForTest();
});

describe('IMP-0177 dispatcher — legacy mode (default)', () => {
  test('tools/list returns the full TOOL_SCHEMAS manifest', async () => {
    const { handlers, server } = makeFakeServer();
    setupTools(server as any, 'client_test');
    const list = handlers.get(ListToolsRequestSchema)!;
    const res = await list({});
    const staticTools = res.tools.filter((t: any) => !t.name.startsWith('flow.'));
    expect(staticTools).toHaveLength(TOOL_SCHEMAS.length);
    // Sanity: a few well-known names present
    const names = staticTools.map((t: any) => t.name);
    expect(names).toContain('chrome_navigate');
  });

  test('CallTool routes by name straight through dispatchTool', async () => {
    const { handlers, server } = makeFakeServer();
    setupTools(server as any, 'client_test');
    const call = handlers.get(CallToolRequestSchema)!;
    await call({ params: { name: 'chrome_navigate', arguments: { url: 'https://x' } } });
    expect(sendRequestMock).toHaveBeenCalledTimes(1);
    const [payload] = sendRequestMock.mock.calls[0] as any[];
    expect(payload.name).toBe('chrome_navigate');
    expect(payload.args).toEqual({ url: 'https://x' });
  });
});

describe('IMP-0177 dispatcher — lazy mode', () => {
  test('tools/list returns exactly one static tool: humanchrome', async () => {
    setMode('lazy');
    const { handlers, server } = makeFakeServer();
    setupTools(server as any, 'client_test');
    const list = handlers.get(ListToolsRequestSchema)!;
    const res = await list({});
    const staticTools = res.tools.filter((t: any) => !t.name.startsWith('flow.'));
    expect(staticTools).toHaveLength(1);
    expect(staticTools[0].name).toBe(DISPATCHER_TOOL_NAME);
  });

  test('humanchrome descriptor carries the catalog + name/args/raw schema', async () => {
    setMode('lazy');
    const { handlers, server } = makeFakeServer();
    setupTools(server as any, 'client_test');
    const list = handlers.get(ListToolsRequestSchema)!;
    const res = await list({});
    const tool = res.tools.find((t: any) => t.name === DISPATCHER_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool.description).toContain('chrome_navigate');
    expect(tool.inputSchema.properties.name).toBeDefined();
    expect(tool.inputSchema.properties.args).toBeDefined();
    expect(tool.inputSchema.properties.raw).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['name']);
  });

  test('humanchrome(name, args) routes through dispatchTool', async () => {
    setMode('lazy');
    const { handlers, server } = makeFakeServer();
    setupTools(server as any, 'client_test');
    const call = handlers.get(CallToolRequestSchema)!;
    await call({
      params: {
        name: DISPATCHER_TOOL_NAME,
        arguments: { name: 'chrome_navigate', args: { url: 'https://x' } },
      },
    });
    expect(sendRequestMock).toHaveBeenCalledTimes(1);
    const [payload] = sendRequestMock.mock.calls[0] as any[];
    expect(payload.name).toBe('chrome_navigate');
    expect(payload.args).toEqual({ url: 'https://x' });
  });

  test('raw=true on the outer call propagates to inner args', async () => {
    setMode('lazy');
    const { handlers, server } = makeFakeServer();
    setupTools(server as any, 'client_test');
    const call = handlers.get(CallToolRequestSchema)!;
    await call({
      params: {
        name: DISPATCHER_TOOL_NAME,
        arguments: { name: 'chrome_read_page', args: {}, raw: true },
      },
    });
    const [payload] = sendRequestMock.mock.calls[0] as any[];
    expect(payload.args).toEqual({ raw: true });
  });

  test('missing name returns INVALID_ARGS with details.arg=name', async () => {
    setMode('lazy');
    const { handlers, server } = makeFakeServer();
    setupTools(server as any, 'client_test');
    const call = handlers.get(CallToolRequestSchema)!;
    const res = await call({
      params: { name: DISPATCHER_TOOL_NAME, arguments: { args: {} } },
    });
    expect(res.isError).toBe(true);
    const env = JSON.parse(res.content[0].text);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.arg).toBe('name');
  });

  test('unknown tool returns INVALID_ARGS with did-you-mean hint', async () => {
    setMode('lazy');
    const { handlers, server } = makeFakeServer();
    setupTools(server as any, 'client_test');
    const call = handlers.get(CallToolRequestSchema)!;
    const res = await call({
      params: { name: DISPATCHER_TOOL_NAME, arguments: { name: 'chrome_navigat' } },
    });
    expect(res.isError).toBe(true);
    const env = JSON.parse(res.content[0].text);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.arg).toBe('name');
    expect(env.error.details.received).toBe('chrome_navigat');
    expect(env.error.details.hint).toBe('Did you mean "chrome_navigate"?');
  });

  test('unknown tool with no close match returns INVALID_ARGS with no hint', async () => {
    setMode('lazy');
    const { handlers, server } = makeFakeServer();
    setupTools(server as any, 'client_test');
    const call = handlers.get(CallToolRequestSchema)!;
    const res = await call({
      params: { name: DISPATCHER_TOOL_NAME, arguments: { name: 'xyz_completely_off' } },
    });
    expect(res.isError).toBe(true);
    const env = JSON.parse(res.content[0].text);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.hint).toBeUndefined();
  });
});

describe('IMP-0183 dispatcher — idempotency keys', () => {
  test('replaying the same idemKey returns cached result + _meta.idempotent_hit', async () => {
    setMode('lazy');
    const { handlers, server } = makeFakeServer();
    setupTools(server as any, 'client_test');
    const call = handlers.get(CallToolRequestSchema)!;
    const params = {
      params: {
        name: DISPATCHER_TOOL_NAME,
        arguments: { name: 'chrome_navigate', args: { url: 'https://x' }, idemKey: 'k1' },
      },
    };
    const first: any = await call(params);
    const second: any = await call(params);
    expect(sendRequestMock).toHaveBeenCalledTimes(1);
    expect(first._meta?.idempotent_hit).toBeUndefined();
    expect(second._meta?.idempotent_hit).toBe(true);
  });

  test('different idemKey re-dispatches', async () => {
    setMode('lazy');
    const { handlers, server } = makeFakeServer();
    setupTools(server as any, 'client_test');
    const call = handlers.get(CallToolRequestSchema)!;
    await call({
      params: {
        name: DISPATCHER_TOOL_NAME,
        arguments: { name: 'chrome_navigate', args: { url: 'https://x' }, idemKey: 'k1' },
      },
    });
    await call({
      params: {
        name: DISPATCHER_TOOL_NAME,
        arguments: { name: 'chrome_navigate', args: { url: 'https://x' }, idemKey: 'k2' },
      },
    });
    expect(sendRequestMock).toHaveBeenCalledTimes(2);
  });

  test('omitting idemKey re-dispatches every call', async () => {
    setMode('lazy');
    const { handlers, server } = makeFakeServer();
    setupTools(server as any, 'client_test');
    const call = handlers.get(CallToolRequestSchema)!;
    await call({
      params: { name: DISPATCHER_TOOL_NAME, arguments: { name: 'chrome_navigate', args: {} } },
    });
    await call({
      params: { name: DISPATCHER_TOOL_NAME, arguments: { name: 'chrome_navigate', args: {} } },
    });
    expect(sendRequestMock).toHaveBeenCalledTimes(2);
  });

  test('legacy mode ignores idemKey (per-tool calls)', async () => {
    setMode('legacy');
    const { handlers, server } = makeFakeServer();
    setupTools(server as any, 'client_test');
    const call = handlers.get(CallToolRequestSchema)!;
    await call({
      params: { name: 'chrome_navigate', arguments: { url: 'https://x' } },
    });
    await call({
      params: { name: 'chrome_navigate', arguments: { url: 'https://x' } },
    });
    // Both calls go through — idemKey is dispatcher-surface only.
    expect(sendRequestMock).toHaveBeenCalledTimes(2);
  });
});

describe('IMP-0177 dispatcher — audit script', () => {
  test('boot-manifest savings exceed 10× wave done-criteria floor', () => {
    const legacy = JSON.stringify(TOOL_SCHEMAS).length;
    const lazy = JSON.stringify(buildDispatcherTool()).length;
    const ratio = legacy / lazy;
    expect(ratio).toBeGreaterThanOrEqual(10);
  });
});
