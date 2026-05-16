/**
 * chrome_file_upload tests.
 *
 * Pins the post-IMP-0096 behaviour: the synthesized change event is
 * dispatched via DOM.resolveNode → Runtime.callFunctionOn against the
 * objectId, never by interpolating the user-controlled selector into a
 * Runtime.evaluate expression. The regression class — selectors with
 * single-quotes, double-quotes, backslashes, or newlines silently failing
 * to fire onChange — is covered explicitly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  cdpWithSession: vi.fn(),
  cdpSendCommand: vi.fn(),
  sendNativeRequest: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    withSession: stubs.cdpWithSession,
    sendCommand: stubs.cdpSendCommand,
  },
}));

vi.mock('@/entrypoints/background/native-host', () => ({
  sendNativeRequest: stubs.sendNativeRequest,
  initNativeHostListener: () => {},
}));

async function loadTool(): Promise<
  typeof import('@/entrypoints/background/tools/browser/file-upload')
> {
  vi.resetModules();
  return await import('@/entrypoints/background/tools/browser/file-upload');
}

interface InstallOpts {
  tabId?: number;
  describeNode?: { nodeName: string; attributes?: string[] };
  querySelectorNodeId?: number;
  resolveNodeObjectId?: string;
}

const DEFAULT_NODE_ID = 42;
const DEFAULT_DOCUMENT_NODE_ID = 1;
const DEFAULT_OBJECT_ID = 'inj:abc123';

function installChrome(opts: InstallOpts = {}) {
  const tabId = opts.tabId ?? 7;
  const tab: chrome.tabs.Tab = {
    id: tabId,
    windowId: 11,
    url: 'https://example.com/upload',
    title: 'Upload',
  } as any;

  (globalThis as unknown as { chrome: any }).chrome = {
    runtime: {
      id: 'test',
      sendMessage: vi.fn(),
      getURL: (p: string) => `chrome-extension://test${p}`,
    },
    tabs: {
      get: vi.fn(async () => tab),
      query: vi.fn(async () => [tab]),
      sendMessage: vi.fn(),
      onCreated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    webNavigation: {
      getFrame: vi.fn(async () => ({ url: tab.url, documentId: 'doc-1' })),
    },
    windows: {
      update: vi.fn(),
      onRemoved: { addListener: vi.fn() },
    },
  };

  const describeNode = opts.describeNode ?? {
    nodeName: 'INPUT',
    attributes: ['type', 'file'],
  };
  const querySelectorNodeId = opts.querySelectorNodeId ?? DEFAULT_NODE_ID;
  const resolveNodeObjectId = opts.resolveNodeObjectId ?? DEFAULT_OBJECT_ID;

  // Default sendCommand handler: route by CDP method name so tests can assert
  // on the exact sequence (DOM.querySelector → DOM.describeNode →
  // DOM.setFileInputFiles → DOM.resolveNode → Runtime.callFunctionOn) without
  // micro-stubbing each call's resolved value.
  stubs.cdpSendCommand.mockImplementation(async (_tabId: number, method: string, _params?: any) => {
    switch (method) {
      case 'DOM.enable':
      case 'Runtime.enable':
        return {};
      case 'DOM.getDocument':
        return { root: { nodeId: DEFAULT_DOCUMENT_NODE_ID } };
      case 'DOM.querySelector':
        return { nodeId: querySelectorNodeId };
      case 'DOM.describeNode':
        return { node: describeNode };
      case 'DOM.setFileInputFiles':
        return {};
      case 'DOM.resolveNode':
        return { object: { objectId: resolveNodeObjectId } };
      case 'Runtime.callFunctionOn':
        return { result: { type: 'undefined' } };
      default:
        return {};
    }
  });

  // withSession just runs the inner fn; the cdp-session-manager unit tests
  // already cover attach/detach refcounting.
  stubs.cdpWithSession.mockImplementation(async (_t: number, _o: string, fn: any) => fn());

  return { tab, tabId };
}

beforeEach(() => {
  stubs.cdpWithSession.mockReset();
  stubs.cdpSendCommand.mockReset();
  stubs.sendNativeRequest.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_file_upload: arg validation', () => {
  it('rejects when selector is missing', async () => {
    installChrome();
    const { fileUploadTool } = await loadTool();
    const res = await fileUploadTool.execute({ filePath: '/tmp/a.txt' } as any);
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('Selector is required');
  });

  it('rejects when no file source is provided', async () => {
    installChrome();
    const { fileUploadTool } = await loadTool();
    const res = await fileUploadTool.execute({ selector: 'input' } as any);
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('filePath');
  });
});

describe('chrome_file_upload: change-event dispatch via objectId (IMP-0096)', () => {
  it('does NOT call Runtime.evaluate with the selector interpolated into an expression', async () => {
    installChrome();
    const { fileUploadTool } = await loadTool();
    const res = await fileUploadTool.execute({
      tabId: 7,
      selector: "input[name='o\\'brien']",
      filePath: '/tmp/a.txt',
    });
    expect(res.isError).toBe(false);
    // The whole point of the fix: no Runtime.evaluate call ever happens.
    const evaluateCalls = stubs.cdpSendCommand.mock.calls.filter(
      ([, method]: any[]) => method === 'Runtime.evaluate',
    );
    expect(evaluateCalls).toHaveLength(0);
  });

  it('resolves the nodeId from DOM.querySelector to an objectId and dispatches via Runtime.callFunctionOn', async () => {
    installChrome();
    const { fileUploadTool } = await loadTool();
    await fileUploadTool.execute({
      tabId: 7,
      selector: 'input[type=file]',
      filePath: '/tmp/a.txt',
    });

    // DOM.resolveNode must receive the same nodeId that DOM.querySelector
    // returned — never a re-resolution from the page side.
    expect(stubs.cdpSendCommand).toHaveBeenCalledWith(
      7,
      'DOM.resolveNode',
      expect.objectContaining({ nodeId: DEFAULT_NODE_ID }),
    );

    // Runtime.callFunctionOn must be bound to the returned objectId, with
    // the canonical "dispatch a bubbling change event" function declaration.
    expect(stubs.cdpSendCommand).toHaveBeenCalledWith(
      7,
      'Runtime.callFunctionOn',
      expect.objectContaining({
        objectId: DEFAULT_OBJECT_ID,
        functionDeclaration: expect.stringContaining("dispatchEvent(new Event('change'"),
      }),
    );
    const callOn = stubs.cdpSendCommand.mock.calls.find(
      ([, method]: any[]) => method === 'Runtime.callFunctionOn',
    )![2];
    expect(callOn.functionDeclaration).toContain('bubbles:true');
  });

  it('issues CDP calls in the correct order: querySelector → describeNode → setFileInputFiles → resolveNode → callFunctionOn', async () => {
    installChrome();
    const { fileUploadTool } = await loadTool();
    await fileUploadTool.execute({
      tabId: 7,
      selector: 'input',
      filePath: '/tmp/a.txt',
    });

    const order = stubs.cdpSendCommand.mock.calls.map(([, method]: any[]) => method);
    const idx = (m: string) => order.indexOf(m);
    expect(idx('DOM.querySelector')).toBeGreaterThanOrEqual(0);
    expect(idx('DOM.describeNode')).toBeGreaterThan(idx('DOM.querySelector'));
    expect(idx('DOM.setFileInputFiles')).toBeGreaterThan(idx('DOM.describeNode'));
    expect(idx('DOM.resolveNode')).toBeGreaterThan(idx('DOM.setFileInputFiles'));
    expect(idx('Runtime.callFunctionOn')).toBeGreaterThan(idx('DOM.resolveNode'));
  });
});

describe('chrome_file_upload: selectors that broke the old eval path now succeed', () => {
  // These selectors all parse fine as CSS but used to silently fail to
  // dispatch the change event under the naive single-quote-only escaping
  // in the previous Runtime.evaluate path.
  const HARD_SELECTORS = [
    { name: 'single-quote in attribute value', selector: "input[name='o\\'brien']" },
    { name: 'double-quote in attribute value', selector: 'input[name="say \\"hi\\""]' },
    { name: 'backslash in attribute value', selector: 'input[name="a\\\\b"]' },
    { name: 'newline in attribute value', selector: 'input[name="line1\\nline2"]' },
    { name: 'mixed single + double quotes', selector: `input[data-x="it's"]` },
    {
      name: 'template-literal-looking ${} fragment in attribute value',
      // Verifies the selector cannot smuggle a template expression into the
      // dispatch path — the new code path doesn't interpolate at all.
      selector: 'input[name="${alert(1)}"]',
    },
  ];

  for (const { name, selector } of HARD_SELECTORS) {
    it(`succeeds end-to-end with ${name}`, async () => {
      installChrome();
      const { fileUploadTool } = await loadTool();
      const res = await fileUploadTool.execute({
        tabId: 7,
        selector,
        filePath: '/tmp/upload.txt',
      });
      expect(res.isError).toBe(false);
      const body = parseBody(res);
      expect(body.success).toBe(true);
      expect(body.selector).toBe(selector);

      // Crucially, the selector is forwarded to DOM.querySelector (CDP
      // parses it server-side, no escaping needed) and never to any
      // Runtime.evaluate or Runtime.callFunctionOn `expression`/`arguments`.
      expect(stubs.cdpSendCommand).toHaveBeenCalledWith(
        7,
        'DOM.querySelector',
        expect.objectContaining({ selector }),
      );
      const evaluateCalls = stubs.cdpSendCommand.mock.calls.filter(
        ([, method]: any[]) => method === 'Runtime.evaluate',
      );
      expect(evaluateCalls).toHaveLength(0);

      // And the change event was still dispatched against the resolved
      // objectId — i.e., the form-handler-onChange contract is preserved.
      expect(stubs.cdpSendCommand).toHaveBeenCalledWith(
        7,
        'Runtime.callFunctionOn',
        expect.objectContaining({ objectId: DEFAULT_OBJECT_ID }),
      );
    });
  }
});

describe('chrome_file_upload: error classification', () => {
  it('reports "not found" when DOM.querySelector returns nodeId 0', async () => {
    installChrome({ querySelectorNodeId: 0 });
    const { fileUploadTool } = await loadTool();
    const res = await fileUploadTool.execute({
      tabId: 7,
      selector: '#missing',
      filePath: '/tmp/a.txt',
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('not found');
  });

  it('rejects elements that are not <input>', async () => {
    installChrome({ describeNode: { nodeName: 'DIV', attributes: [] } });
    const { fileUploadTool } = await loadTool();
    const res = await fileUploadTool.execute({
      tabId: 7,
      selector: 'div',
      filePath: '/tmp/a.txt',
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('not an input element');
  });

  it('rejects inputs that are not type=file', async () => {
    installChrome({
      describeNode: { nodeName: 'INPUT', attributes: ['type', 'text'] },
    });
    const { fileUploadTool } = await loadTool();
    const res = await fileUploadTool.execute({
      tabId: 7,
      selector: 'input',
      filePath: '/tmp/a.txt',
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('not a file input');
  });
});

describe('chrome_file_upload: happy-path envelope', () => {
  it('returns success envelope including the original selector and file list', async () => {
    installChrome();
    const { fileUploadTool } = await loadTool();
    const res = await fileUploadTool.execute({
      tabId: 7,
      selector: "input[name='o\\'brien']",
      filePath: '/tmp/file.txt',
    });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.success).toBe(true);
    expect(body.files).toEqual(['/tmp/file.txt']);
    expect(body.fileCount).toBe(1);
    expect(body.selector).toBe("input[name='o\\'brien']");
  });
});
