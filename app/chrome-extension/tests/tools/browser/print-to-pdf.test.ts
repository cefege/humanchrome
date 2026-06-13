/**
 * chrome_print_to_pdf tests.
 *
 * Wraps Page.printToPDF via cdpSessionManager.withSession.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/entrypoints/background/native-host', () => ({
  sendNativeRequest: vi.fn(),
}));

const sendCommandMock = vi.fn(async () => ({ data: SAMPLE_PDF_DATA }));
const withSessionMock = vi.fn(async (_tabId: number, _owner: string, fn: () => Promise<any>) =>
  fn(),
);

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    withSession: (...args: unknown[]) => (withSessionMock as (...a: unknown[]) => unknown)(...args),
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    sendCommand: vi.fn(async () => undefined),
  },
}));

import { printToPdfTool } from '@/entrypoints/background/tools/browser/print-to-pdf';
import { sendNativeRequest } from '@/entrypoints/background/native-host';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const TEST_CLIENT = 'print-to-pdf-test-client';

function exec(args: any): Promise<any> {
  return runWithContext({ clientId: TEST_CLIENT }, () => printToPdfTool.execute(args));
}

let tabsGetMock: ReturnType<typeof vi.fn>;

const SAMPLE_PDF_DATA = 'JVBERi0xLjQKJeLjz9MK'; // valid-looking base64 prefix

beforeEach(() => {
  _resetClientStateForTests();
  sendCommandMock.mockReset();
  sendCommandMock.mockResolvedValue({ data: SAMPLE_PDF_DATA });
  withSessionMock.mockReset();
  withSessionMock.mockImplementation(
    async (_tabId: number, _owner: string, fn: () => Promise<any>) => fn(),
  );
  tabsGetMock = vi.fn(async (id: number) => ({ id, url: 'https://example.com', windowId: 1 }));
  (globalThis.chrome as any).debugger = {
    sendCommand: sendCommandMock,
  };
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    get: tabsGetMock,
  };
  (sendNativeRequest as any).mockReset();
});

afterEach(() => {
  _resetClientStateForTests();
  delete (globalThis.chrome as any).debugger;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_print_to_pdf', () => {
  it('falls back to the client-owned tab when no tabId is provided', async () => {
    claimTabForClient(TEST_CLIENT, 1, 1);
    await exec({});
    expect(sendCommandMock).toHaveBeenCalledWith(
      { tabId: 1 },
      'Page.printToPDF',
      expect.any(Object),
    );
  });

  it('returns base64 by default', async () => {
    const res = await exec({ tabId: 7 });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.base64).toBe(SAMPLE_PDF_DATA);
    expect(body.bytes).toBe(Math.floor((SAMPLE_PDF_DATA.length * 3) / 4));
  });

  it('passes formatting options to Page.printToPDF', async () => {
    await exec({
      tabId: 7,
      landscape: true,
      printBackground: false,
      scale: 0.8,
      paperWidthIn: 8.27,
      paperHeightIn: 11.69,
      marginTopIn: 0.2,
      marginRightIn: 0.3,
      marginBottomIn: 0.4,
      marginLeftIn: 0.5,
      pageRanges: '1-3',
    });
    const call = sendCommandMock.mock.calls[0] as unknown as [unknown, string, any];
    const params = call[2];
    expect(params.landscape).toBe(true);
    expect(params.printBackground).toBe(false);
    expect(params.scale).toBe(0.8);
    expect(params.paperWidth).toBe(8.27);
    expect(params.paperHeight).toBe(11.69);
    expect(params.marginTop).toBe(0.2);
    expect(params.marginLeft).toBe(0.5);
    expect(params.pageRanges).toBe('1-3');
  });

  it('writes via the bridge when savePath is provided', async () => {
    (sendNativeRequest as any).mockResolvedValue({
      success: true,
      filePath: '/tmp/out.pdf',
      bytes: 1234,
    });
    const res = await exec({ tabId: 7, savePath: '/tmp/out.pdf' });
    expect(sendNativeRequest).toHaveBeenCalledWith(
      'file_operation',
      expect.objectContaining({
        action: 'saveToPath',
        destPath: '/tmp/out.pdf',
        base64Data: SAMPLE_PDF_DATA,
      }),
      expect.any(Number),
    );
    expect(parseBody(res).path).toBe('/tmp/out.pdf');
  });

  it('classifies "no tab with id" as TAB_CLOSED', async () => {
    sendCommandMock.mockRejectedValueOnce(new Error('No tab with id: 7'));
    const res = await exec({ tabId: 7 });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.code).toBe('TAB_CLOSED');
  });

  it('uses withSession for balanced CDP lifecycle', async () => {
    await exec({ tabId: 7 });
    expect(withSessionMock).toHaveBeenCalledWith(7, 'print-to-pdf', expect.any(Function));
  });

  it('classifies CDP_BUSY from withSession', async () => {
    withSessionMock.mockRejectedValueOnce(new Error('Another CDP client is attached to tab 7'));
    const res = await exec({ tabId: 7 });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error.code).toBe('CDP_BUSY');
  });

  it('reports a bridge save failure', async () => {
    (sendNativeRequest as any).mockResolvedValue({ success: false, error: 'EACCES' });
    const res = await exec({ tabId: 7, savePath: '/root/forbidden.pdf' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('EACCES');
  });
});
