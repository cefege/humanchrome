/**
 * chrome_aria_snapshot tests (IMP-0127).
 *
 * Covers: formatter strips coord/attribute decorations while preserving
 * indentation + role/name/ref; tab-resolution wiring + sendMessage path;
 * filter mode (interactiveOnly defaults true); includeRefs:false drops
 * ref markers; 1 MiB truncation envelope; refId is forwarded; error
 * envelope when the helper fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ariaSnapshotTool,
  _formatPageContentForTests as fmt,
} from '@/entrypoints/background/tools/browser/aria-snapshot';
import { runWithContext } from '@/entrypoints/background/utils/request-context';
import {
  _resetClientStateForTests,
  claimTabForClient,
} from '@/entrypoints/background/utils/client-state';

const TEST_CLIENT = 'aria-snapshot-test-client';
const TAB_ID = 42;

function exec(args: any = {}): Promise<any> {
  return runWithContext({ clientId: TEST_CLIENT }, () => ariaSnapshotTool.execute(args));
}

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

let sendMessageMock: ReturnType<typeof vi.fn>;
let executeScriptMock: ReturnType<typeof vi.fn>;
// Queue of responses for the GENERATE_ACCESSIBILITY_TREE message; ping
// messages are answered synthetically with {status:'pong'}.
let treeResponses: any[] = [];
// Captured payload of the latest GENERATE_ACCESSIBILITY_TREE call.
let lastTreeCall: any = null;

beforeEach(() => {
  _resetClientStateForTests();
  treeResponses = [];
  lastTreeCall = null;
  sendMessageMock = vi.fn(async (_tabId: number, message: any) => {
    // pingOnce/waitForPing send `{action: '<toolName>_ping'}` — return pong
    // so injectContentScript short-circuits before reaching executeScript.
    if (message?.action && String(message.action).endsWith('_ping')) {
      return { status: 'pong' };
    }
    if (message?.action === 'generateAccessibilityTree') {
      lastTreeCall = message;
      const next = treeResponses.shift();
      if (!next) throw new Error('no queued tree response');
      return next;
    }
    throw new Error(`unexpected sendMessage action: ${message?.action}`);
  });
  executeScriptMock = vi.fn(async () => [{ result: undefined }]);

  (globalThis.chrome as any) = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: 1, url: 'https://x' })),
      sendMessage: sendMessageMock,
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

describe('chrome_aria_snapshot — formatter', () => {
  it('strips coords + id/href/type/placeholder/disabled/pe decorations, preserves indent + role + ref', () => {
    const input = [
      '- button "Submit" [ref=ref_12] (x=120,y=30) id="submit-btn"',
      '  - link "Privacy" [ref=ref_13] (x=200,y=30) href="/privacy"',
      '    - textbox "Email" [ref=ref_14] (x=300,y=80) placeholder="you@example.com" type="email"',
      '      - button "Disabled" [ref=ref_15] (x=10,y=10) disabled pe=none',
    ].join('\n');
    const out = fmt(input, { includeRefs: true });
    expect(out).toBe(
      [
        '- button "Submit" [ref=ref_12]',
        '  - link "Privacy" [ref=ref_13]',
        '    - textbox "Email" [ref=ref_14]',
        '      - button "Disabled" [ref=ref_15]',
      ].join('\n'),
    );
  });

  it('includeRefs:false drops ref markers too', () => {
    const input = '- button "Submit" [ref=ref_12] (x=120,y=30)';
    expect(fmt(input, { includeRefs: false })).toBe('- button "Submit"');
  });

  it('skips blank lines', () => {
    const input = '- button "A" [ref=r1]\n\n  - link "B" [ref=r2]\n';
    expect(fmt(input, { includeRefs: true })).toBe('- button "A" [ref=r1]\n  - link "B" [ref=r2]');
  });
});

describe('chrome_aria_snapshot — dispatch', () => {
  it('defaults filter:interactive, returns success + lineCount + refCount', async () => {
    treeResponses.push({
      success: true,
      pageContent: '- button "Submit" [ref=r1] (x=10,y=10)\n- link "Home" [ref=r2] (x=10,y=30)',
      refMap: [
        { ref: 'r1', selector: '#submit', rect: {} },
        { ref: 'r2', selector: 'a.home', rect: {} },
      ],
      stats: { processed: 5, included: 2, durationMs: 12 },
      viewport: { width: 1280, height: 800, dpr: 2 },
    });

    const res = await exec({});
    expect(res.isError).toBe(false);
    expect(lastTreeCall?.filter).toBe('interactive');

    const body = parseBody(res);
    expect(body.snapshot).toBe('- button "Submit" [ref=r1]\n- link "Home" [ref=r2]');
    expect(body.lineCount).toBe(2);
    expect(body.refCount).toBe(2);
    expect(body.filter).toBe('interactive');
    expect(body.stats.included).toBe(2);
    expect(body.viewport).toEqual({ width: 1280, height: 800, dpr: 2 });
  });

  it('interactiveOnly:false widens to filter:all', async () => {
    treeResponses.push({
      success: true,
      pageContent: '- main [ref=r1] (x=0,y=0)\n  - heading "Welcome" [ref=r2] (x=10,y=20)',
      refMap: [],
    });
    await exec({ interactiveOnly: false });
    expect(lastTreeCall?.filter).toBe('all');
  });

  it('forwards refId to the helper for subtree snapshot', async () => {
    treeResponses.push({
      success: true,
      pageContent: '- list "Items" [ref=ref_99]',
      refMap: [],
      focus: { refId: 'ref_99', found: true },
    });
    const res = await exec({ refId: 'ref_99' });
    expect(lastTreeCall?.refId).toBe('ref_99');
    expect(parseBody(res).focus).toEqual({ refId: 'ref_99', found: true });
  });

  it('returns UNKNOWN error envelope when the helper reports failure', async () => {
    treeResponses.push({
      success: false,
      error: 'ref "ref_99" not found or expired',
    });
    const res = await exec({ refId: 'ref_99' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('ref_99');
  });

  it('surfaces TAB_NOT_FOUND when the owned tab no longer exists', async () => {
    // Make chrome.tabs.get throw — getOwnedTab catches and rethrows as
    // ToolError(TAB_NOT_FOUND, reason:'closed'); the tool's catch
    // preserves that structured code.
    (globalThis.chrome as any).tabs.get = vi.fn(async () => {
      throw new Error('No tab with id: 42');
    });
    const res = await exec({});
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_NOT_FOUND');
  });

  it('truncates output past 1 MiB and reports the truncation envelope', async () => {
    // Build a >1 MiB pageContent of lines whose stripped form is still
    // long enough to overflow. Long label = preserved; coord decoration
    // = stripped. Pick label length so output > 1 MiB.
    const label = 'x'.repeat(900); // preserved
    const line = `- button "${label}" [ref=r1] (x=0,y=0)`; // ~930 chars
    const linesNeeded = Math.ceil((1.5 * 1024 * 1024) / (line.length + 1));
    const big = Array.from({ length: linesNeeded }, () => line).join('\n');
    treeResponses.push({
      success: true,
      pageContent: big,
      refMap: [],
    });

    const res = await exec({});
    const body = parseBody(res);
    expect(body.truncation).toBeDefined();
    expect(body.truncation.truncated).toBe(true);
    expect(body.truncation.unit).toBe('bytes');
    expect(Buffer.byteLength(body.snapshot, 'utf8')).toBeLessThanOrEqual(body.truncation.limit);
  });
});
