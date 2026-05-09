/**
 * chrome_tab_lifecycle tests.
 *
 * Memory + audio controls on tabs. Stubs chrome.tabs.discard / update.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tabLifecycleTool } from '@/entrypoints/background/tools/browser/tab-lifecycle';

const SAMPLE_TAB = {
  id: 7,
  url: 'https://example.com',
  title: 'Example',
  discarded: false,
  autoDiscardable: true,
  mutedInfo: { muted: false, reason: null },
};

let discardMock: ReturnType<typeof vi.fn>;
let updateMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  discardMock = vi.fn().mockResolvedValue({ ...SAMPLE_TAB, discarded: true });
  updateMock = vi.fn().mockResolvedValue({ ...SAMPLE_TAB });
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    discard: discardMock,
    update: updateMock,
  };
});

afterEach(() => {
  // Leave chrome.tabs (other tests rely on it).
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_tab_lifecycle', () => {
  it('rejects unknown action', async () => {
    const res = await tabLifecycleTool.execute({ tabId: 1 } as any);
    expect(res.isError).toBe(true);
  });

  it('rejects missing tabId', async () => {
    const res = await tabLifecycleTool.execute({ action: 'discard' } as any);
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('tabId');
  });

  it('discard forwards tabId and reports discarded:true', async () => {
    const res = await tabLifecycleTool.execute({ action: 'discard', tabId: 7 });
    expect(discardMock).toHaveBeenCalledWith(7);
    expect(parseBody(res).tab.discarded).toBe(true);
  });

  it('mute calls chrome.tabs.update(tabId, {muted:true})', async () => {
    await tabLifecycleTool.execute({ action: 'mute', tabId: 7 });
    expect(updateMock).toHaveBeenCalledWith(7, { muted: true });
  });

  it('unmute calls chrome.tabs.update(tabId, {muted:false})', async () => {
    await tabLifecycleTool.execute({ action: 'unmute', tabId: 7 });
    expect(updateMock).toHaveBeenCalledWith(7, { muted: false });
  });

  it('set_auto_discardable requires the autoDiscardable flag', async () => {
    const res = await tabLifecycleTool.execute({
      action: 'set_auto_discardable',
      tabId: 7,
    } as any);
    expect(res.isError).toBe(true);
  });

  it('set_auto_discardable forwards the flag', async () => {
    await tabLifecycleTool.execute({
      action: 'set_auto_discardable',
      tabId: 7,
      autoDiscardable: false,
    });
    expect(updateMock).toHaveBeenCalledWith(7, { autoDiscardable: false });
  });

  it('classifies "no tab with id" rejection as TAB_CLOSED', async () => {
    discardMock.mockRejectedValueOnce(new Error('No tab with id: 7'));
    const res = await tabLifecycleTool.execute({ action: 'discard', tabId: 7 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_CLOSED');
  });

  it('returns TAB_CLOSED when discard yields undefined', async () => {
    discardMock.mockResolvedValueOnce(undefined);
    const res = await tabLifecycleTool.execute({ action: 'discard', tabId: 7 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_CLOSED');
  });
});
