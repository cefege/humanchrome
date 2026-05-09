/**
 * chrome_print_to_pdf tests.
 *
 * Wraps Page.printToPDF via chrome.debugger.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/entrypoints/background/native-host', () => ({
  sendNativeRequest: vi.fn(),
}));

import { printToPdfTool } from '@/entrypoints/background/tools/browser/print-to-pdf';
import { sendNativeRequest } from '@/entrypoints/background/native-host';

let attachMock: ReturnType<typeof vi.fn>;
let detachMock: ReturnType<typeof vi.fn>;
let sendCommandMock: ReturnType<typeof vi.fn>;
let queryMock: ReturnType<typeof vi.fn>;

const SAMPLE_PDF_DATA = 'JVBERi0xLjQKJeLjz9MK'; // valid-looking base64 prefix

beforeEach(() => {
  attachMock = vi.fn().mockResolvedValue(undefined);
  detachMock = vi.fn().mockResolvedValue(undefined);
  sendCommandMock = vi.fn().mockResolvedValue({ data: SAMPLE_PDF_DATA });
  queryMock = vi.fn().mockResolvedValue([{ id: 1, url: 'https://example.com' }]);
  (globalThis.chrome as any).debugger = {
    attach: attachMock,
    detach: detachMock,
    sendCommand: sendCommandMock,
  };
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    query: queryMock,
  };
  (sendNativeRequest as any).mockReset();
});

afterEach(() => {
  delete (globalThis.chrome as any).debugger;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_print_to_pdf', () => {
  it('falls back to the active tab when no tabId is provided', async () => {
    await printToPdfTool.execute({});
    expect(sendCommandMock).toHaveBeenCalledWith(
      { tabId: 1 },
      'Page.printToPDF',
      expect.any(Object),
    );
  });

  it('returns base64 by default', async () => {
    const res = await printToPdfTool.execute({ tabId: 7 });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.base64).toBe(SAMPLE_PDF_DATA);
    expect(body.bytes).toBe(Math.floor((SAMPLE_PDF_DATA.length * 3) / 4));
  });

  it('passes formatting options to Page.printToPDF', async () => {
    await printToPdfTool.execute({
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
    const params = sendCommandMock.mock.calls[0][2];
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
    const res = await printToPdfTool.execute({ tabId: 7, savePath: '/tmp/out.pdf' });
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
    const res = await printToPdfTool.execute({ tabId: 7 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_CLOSED');
  });

  it('detaches the debugger after a successful print', async () => {
    await printToPdfTool.execute({ tabId: 7 });
    expect(detachMock).toHaveBeenCalledWith({ tabId: 7 });
  });

  it('treats "already attached" as success and does NOT detach (preserving caller state)', async () => {
    attachMock.mockRejectedValueOnce(new Error('Another debugger is already attached'));
    await printToPdfTool.execute({ tabId: 7 });
    expect(detachMock).not.toHaveBeenCalled();
  });

  it('reports a bridge save failure', async () => {
    (sendNativeRequest as any).mockResolvedValue({ success: false, error: 'EACCES' });
    const res = await printToPdfTool.execute({ tabId: 7, savePath: '/root/forbidden.pdf' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('EACCES');
  });
});
