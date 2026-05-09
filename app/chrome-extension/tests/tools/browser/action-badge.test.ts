/**
 * chrome_action_badge tests.
 *
 * Wraps chrome.action.setBadgeText / setBadgeBackgroundColor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { actionBadgeTool } from '@/entrypoints/background/tools/browser/action-badge';

let setBadgeTextMock: ReturnType<typeof vi.fn>;
let setBadgeBackgroundColorMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setBadgeTextMock = vi.fn().mockResolvedValue(undefined);
  setBadgeBackgroundColorMock = vi.fn().mockResolvedValue(undefined);
  (globalThis.chrome as any).action = {
    setBadgeText: setBadgeTextMock,
    setBadgeBackgroundColor: setBadgeBackgroundColorMock,
  };
});

afterEach(() => {
  delete (globalThis.chrome as any).action;
});

describe('chrome_action_badge', () => {
  it('rejects unknown action', async () => {
    const res = await actionBadgeTool.execute({} as any);
    expect(res.isError).toBe(true);
  });

  it('errors when chrome.action is undefined', async () => {
    delete (globalThis.chrome as any).action;
    const res = await actionBadgeTool.execute({ action: 'set', text: 'x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('chrome.action is unavailable');
  });

  it('set requires text', async () => {
    const res = await actionBadgeTool.execute({ action: 'set' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('text');
  });

  it('set forwards text and parses #RRGGBB color', async () => {
    await actionBadgeTool.execute({ action: 'set', text: '3', color: '#FF0011' });
    expect(setBadgeTextMock).toHaveBeenCalledWith({ text: '3' });
    expect(setBadgeBackgroundColorMock).toHaveBeenCalledWith({
      color: [0xff, 0x00, 0x11, 0xff],
    });
  });

  it('set parses #RRGGBBAA color (preserves alpha)', async () => {
    await actionBadgeTool.execute({ action: 'set', text: '!', color: '#11223380' });
    expect(setBadgeBackgroundColorMock).toHaveBeenCalledWith({
      color: [0x11, 0x22, 0x33, 0x80],
    });
  });

  it('set rejects malformed color', async () => {
    const res = await actionBadgeTool.execute({ action: 'set', text: 'x', color: 'red' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('color');
  });

  it('set scopes by tabId when provided', async () => {
    await actionBadgeTool.execute({ action: 'set', text: 'x', tabId: 42 });
    expect(setBadgeTextMock).toHaveBeenCalledWith({ text: 'x', tabId: 42 });
  });

  it('clear sets empty text globally', async () => {
    await actionBadgeTool.execute({ action: 'clear' });
    expect(setBadgeTextMock).toHaveBeenCalledWith({ text: '' });
  });

  it('clear scopes by tabId when provided', async () => {
    await actionBadgeTool.execute({ action: 'clear', tabId: 9 });
    expect(setBadgeTextMock).toHaveBeenCalledWith({ text: '', tabId: 9 });
  });

  it('does not call setBadgeBackgroundColor when no color is supplied', async () => {
    await actionBadgeTool.execute({ action: 'set', text: 'x' });
    expect(setBadgeBackgroundColorMock).not.toHaveBeenCalled();
  });
});
