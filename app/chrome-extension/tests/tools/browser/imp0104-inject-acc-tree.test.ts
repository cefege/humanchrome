/**
 * IMP-0104 regression: the click + fill tools must inject
 * accessibility-tree-helper.js so the click-helper's strict-mode probe
 * (`window.__hcQuerySelectorUnique`) is reachable. Without it the
 * helper silently falls through to `document.querySelector` and the
 * IMP-0098 multi-match guard is defeated.
 *
 * These tests capture the chrome.scripting.executeScript files[] arg
 * passed by `injectContentScript` for each tool and assert
 * `accessibility-tree-helper.js` is in the list.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { clickTool, fillTool } from '@/entrypoints/background/tools/browser/interaction';

function installChrome() {
  const tabId = 7;
  const tab: chrome.tabs.Tab = {
    id: tabId,
    windowId: 1,
    url: 'https://example.com/',
    title: 'Example',
  } as any;

  const injected: Array<{ files?: string[]; world?: string; target?: any }> = [];

  const executeScript = vi.fn(async (opts: any) => {
    injected.push(opts);
    return [{ result: undefined }];
  });

  // Tool-name pings return falsy so injectContentScript actually fires
  // (pingOnce returns true when response.status === 'pong' and short-circuits
  // injection, hiding the files[] arg we want to assert on). The
  // actionability_ping (IMP-0137 self-test) DOES return pong so the
  // dispatcher's assertHelperPresent doesn't throw INJECTION_FAILED.
  const sendMessage = vi.fn(async (_tid: number, msg: any) => {
    if (msg?.action === 'actionability_ping') return { status: 'pong' };
    if (typeof msg.action === 'string' && msg.action.endsWith('_ping')) {
      return undefined;
    }
    if (msg.action === 'clickElement') {
      return {
        success: true,
        message: 'ok',
        elementInfo: { clickMethod: 'selector' },
        navigationOccurred: false,
      };
    }
    if (msg.action === 'fillElement') {
      return {
        success: true,
        message: 'ok',
        elementInfo: { tagName: 'INPUT', value: 'x' },
      };
    }
    return { success: true };
  });

  (globalThis as unknown as { chrome: any }).chrome = {
    runtime: {
      id: 'test',
      sendMessage: vi.fn(),
      getURL: (p: string) => `chrome-extension://test${p}`,
    },
    tabs: {
      get: vi.fn(async () => tab),
      query: vi.fn(async () => [tab]),
      sendMessage,
      onCreated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    windows: { update: vi.fn(), onRemoved: { addListener: vi.fn() } },
    scripting: { executeScript },
    webNavigation: {
      getFrame: vi.fn(async () => ({ url: 'https://example.com/', documentId: 'doc-1' })),
    },
  };
  return { tab, injected, executeScript };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('IMP-0104 — strict-mode probe injection', () => {
  it('clickTool injects accessibility-tree-helper.js so the probe is reachable', async () => {
    const { injected } = installChrome();
    await clickTool.execute({ selector: '#target', tabId: 7 });

    const files = injected.flatMap((call) => call.files ?? []);
    expect(files).toContain('inject-scripts/accessibility-tree-helper.js');
    expect(files).toContain('inject-scripts/actionability.js');
    expect(files).toContain('inject-scripts/click-helper.js');
  });

  it('fillTool injects accessibility-tree-helper.js so the probe is reachable', async () => {
    const { injected } = installChrome();
    await fillTool.execute({ selector: '#in', value: 'hi', tabId: 7 });

    const files = injected.flatMap((call) => call.files ?? []);
    expect(files).toContain('inject-scripts/accessibility-tree-helper.js');
    expect(files).toContain('inject-scripts/actionability.js');
    expect(files).toContain('inject-scripts/fill-helper.js');
  });

  it('clickTool inject list keeps acc-tree-helper before click-helper (load order)', async () => {
    const { injected } = installChrome();
    await clickTool.execute({ selector: '#target', tabId: 7 });

    const files = injected.flatMap((call) => call.files ?? []);
    const accIdx = files.indexOf('inject-scripts/accessibility-tree-helper.js');
    const clickIdx = files.indexOf('inject-scripts/click-helper.js');
    expect(accIdx).toBeGreaterThanOrEqual(0);
    expect(clickIdx).toBeGreaterThanOrEqual(0);
    expect(accIdx).toBeLessThan(clickIdx);
  });
});
