/**
 * #310 — bridge-side `writeResultTo` sink for `chrome_javascript`.
 *
 * Large JSON payloads (~200 KB) returned by chrome_javascript are written
 * to disk by the bridge and the LLM-facing response shrinks to a small
 * `{success, writtenTo, bytes, sha256, omitted}` ack — keeping the payload
 * out of the model's context.
 *
 * The extension service worker can't write to the filesystem; the bridge
 * (Node) can. So this lives in dispatch.ts and intercepts the result
 * before returning to the MCP handler.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, afterAll, describe, test, expect, jest } from '@jest/globals';

const sendRequestMock = jest.fn() as jest.MockedFunction<(...a: any[]) => Promise<any>>;
jest.mock('../native-messaging-host', () => ({
  __esModule: true,
  default: {
    newRequestId: () => 'rid_test_writeresult',
    sendRequestToExtensionAndWait: (...a: any[]) => sendRequestMock(...a),
  },
}));

// Re-import after mock is registered.
import { dispatchTool } from './dispatch';

const TMP_ROOT = path.join(os.tmpdir(), `hc_writeresult_${process.pid}`);

beforeEach(() => {
  sendRequestMock.mockReset();
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

function jsResponse(result: unknown) {
  return {
    status: 'success',
    data: {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, result }),
        },
      ],
      isError: false,
    },
  };
}

describe('dispatchTool — writeResultTo (#310)', () => {
  test('happy path: writes the result to disk and returns a small ack', async () => {
    const target = path.join(TMP_ROOT, 'happy.json');
    const payload = { items: Array.from({ length: 50 }, (_, i) => ({ i, name: `item-${i}` })) };
    sendRequestMock.mockResolvedValue(jsResponse(payload));

    const res = await dispatchTool(
      'chrome_javascript',
      { code: 'fetch(...)', writeResultTo: target },
      'client_test',
    );

    expect(res.isError).toBe(false);
    const env = JSON.parse((res.content[0] as any).text);
    expect(env).toMatchObject({
      success: true,
      writtenTo: target,
      omitted: 'result',
    });
    expect(typeof env.bytes).toBe('number');
    expect(env.bytes).toBeGreaterThan(0);
    expect(env.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The actual payload only exists in the file, not in the response.
    const onDisk = await fs.readFile(target, 'utf8');
    expect(JSON.parse(onDisk)).toEqual(payload);
    expect((res.content[0] as any).text).not.toContain('item-25');
  });

  test('strips writeResultTo from the args forwarded to the extension', async () => {
    const target = path.join(TMP_ROOT, 'stripped.json');
    sendRequestMock.mockResolvedValue(jsResponse({ ok: true }));

    await dispatchTool(
      'chrome_javascript',
      { code: '1', writeResultTo: target, tabId: 7 },
      'client_test',
    );

    const [payload] = sendRequestMock.mock.calls[0] as any[];
    expect(payload.args).toEqual({ code: '1', tabId: 7 });
    expect('writeResultTo' in payload.args).toBe(false);
  });

  test('creates missing parent directories', async () => {
    const target = path.join(TMP_ROOT, 'nested', 'a', 'b', 'deep.json');
    sendRequestMock.mockResolvedValue(jsResponse({ x: 1 }));

    const res = await dispatchTool(
      'chrome_javascript',
      { code: '1', writeResultTo: target },
      'client_test',
    );

    expect(res.isError).toBe(false);
    const stat = await fs.stat(target);
    expect(stat.isFile()).toBe(true);
  });

  test('relative path rejected with INVALID_ARGS — no SW round-trip', async () => {
    const res = await dispatchTool(
      'chrome_javascript',
      { code: '1', writeResultTo: 'relative.json' },
      'client_test',
    );

    expect(res.isError).toBe(true);
    const env = JSON.parse((res.content[0] as any).text);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(env.error.details.arg).toBe('writeResultTo');
    expect(sendRequestMock).not.toHaveBeenCalled();
  });

  test('empty-string writeResultTo rejected', async () => {
    const res = await dispatchTool(
      'chrome_javascript',
      { code: '1', writeResultTo: '' },
      'client_test',
    );

    expect(res.isError).toBe(true);
    const env = JSON.parse((res.content[0] as any).text);
    expect(env.error.code).toBe('INVALID_ARGS');
    expect(sendRequestMock).not.toHaveBeenCalled();
  });

  test('write failure surfaces as WRITE_FAILED envelope, not a throw', async () => {
    // `/` is a directory — writeFile to `/` (no filename) rejects with EISDIR
    // on macOS and Linux. Use a path that can't possibly be written to.
    const target = path.posix.join('/', 'this-path-does-not-allow-writes-because-it-is-root');
    sendRequestMock.mockResolvedValue(jsResponse({ x: 1 }));

    const res = await dispatchTool(
      'chrome_javascript',
      { code: '1', writeResultTo: target },
      'client_test',
    );

    expect(res.isError).toBe(true);
    const env = JSON.parse((res.content[0] as any).text);
    expect(env.error.message).toMatch(/writeResultTo failed/);
    expect(env.error.details.code).toBe('WRITE_FAILED');
    expect(env.error.details.writtenTo).toBe(target);
  });

  test('other tools ignore writeResultTo (only chrome_javascript opts in)', async () => {
    const target = path.join(TMP_ROOT, 'should_not_be_written.json');
    sendRequestMock.mockResolvedValue({
      status: 'success',
      data: { content: [{ type: 'text', text: '{"ok":true}' }], isError: false },
    });

    await dispatchTool(
      'chrome_navigate',
      { url: 'https://example.com', writeResultTo: target },
      'client_test',
    );

    // The arg was forwarded as-is (no strip) and no file was created.
    const [payload] = sendRequestMock.mock.calls[0] as any[];
    expect(payload.args.writeResultTo).toBe(target);
    await expect(fs.stat(target)).rejects.toThrow();
  });
});
