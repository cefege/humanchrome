/**
 * chrome_block_or_redirect tests.
 *
 * Wraps chrome.declarativeNetRequest.updateSessionRules / getSessionRules.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { blockOrRedirectTool } from '@/entrypoints/background/tools/browser/block-or-redirect';

let updateMock: ReturnType<typeof vi.fn>;
let getMock: ReturnType<typeof vi.fn>;
let sessionRules: any[] = [];

beforeEach(() => {
  sessionRules = [];
  updateMock = vi.fn().mockImplementation(async (opts: any) => {
    if (Array.isArray(opts.removeRuleIds)) {
      sessionRules = sessionRules.filter((r) => !opts.removeRuleIds.includes(r.id));
    }
    if (Array.isArray(opts.addRules)) {
      sessionRules.push(...opts.addRules);
    }
  });
  getMock = vi.fn().mockImplementation(async () => [...sessionRules]);

  (globalThis.chrome as any).declarativeNetRequest = {
    updateSessionRules: updateMock,
    getSessionRules: getMock,
  };
});

afterEach(() => {
  delete (globalThis.chrome as any).declarativeNetRequest;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_block_or_redirect', () => {
  it('rejects unknown action', async () => {
    const res = await blockOrRedirectTool.execute({} as any);
    expect(res.isError).toBe(true);
  });

  it('errors when chrome.declarativeNetRequest is undefined', async () => {
    delete (globalThis.chrome as any).declarativeNetRequest;
    const res = await blockOrRedirectTool.execute({ action: 'list' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('chrome.declarativeNetRequest is unavailable');
  });

  it('add rejects when urlFilter is missing', async () => {
    const res = await blockOrRedirectTool.execute({ action: 'add', ruleAction: 'block' } as any);
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('urlFilter');
  });

  it('add rejects when ruleAction is invalid', async () => {
    const res = await blockOrRedirectTool.execute({
      action: 'add',
      urlFilter: 'example.com',
    } as any);
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('ruleAction');
  });

  it('add for redirect rejects when redirectUrl is missing', async () => {
    const res = await blockOrRedirectTool.execute({
      action: 'add',
      urlFilter: 'example.com',
      ruleAction: 'redirect',
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('redirectUrl');
  });

  it('add for block creates a rule with auto-assigned id', async () => {
    const res = await blockOrRedirectTool.execute({
      action: 'add',
      urlFilter: '||example.com/api',
      ruleAction: 'block',
    });
    expect(res.isError).toBe(false);
    expect(parseBody(res).ruleId).toBe(1);
    expect(updateMock).toHaveBeenCalledWith({
      addRules: [
        expect.objectContaining({
          id: 1,
          action: { type: 'block' },
          condition: expect.objectContaining({ urlFilter: '||example.com/api' }),
        }),
      ],
    });
  });

  it('add for redirect builds the redirect.url action', async () => {
    await blockOrRedirectTool.execute({
      action: 'add',
      urlFilter: '||old.example.com',
      ruleAction: 'redirect',
      redirectUrl: 'https://new.example.com/',
    });
    expect(updateMock).toHaveBeenCalledWith({
      addRules: [
        expect.objectContaining({
          action: { type: 'redirect', redirect: { url: 'https://new.example.com/' } },
        }),
      ],
    });
  });

  it('add applies resourceTypes when provided', async () => {
    await blockOrRedirectTool.execute({
      action: 'add',
      urlFilter: 'example.com',
      ruleAction: 'block',
      resourceTypes: ['xmlhttprequest', 'script'],
    });
    const rule = updateMock.mock.calls[0][0].addRules[0];
    expect(rule.condition.resourceTypes).toEqual(['xmlhttprequest', 'script']);
  });

  it('add increments ruleId based on existing rules', async () => {
    sessionRules = [
      { id: 5, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'a' } },
    ];
    const res = await blockOrRedirectTool.execute({
      action: 'add',
      urlFilter: 'b',
      ruleAction: 'block',
    });
    expect(parseBody(res).ruleId).toBe(6);
  });

  it('remove forwards the ruleId', async () => {
    await blockOrRedirectTool.execute({ action: 'remove', ruleId: 42 });
    expect(updateMock).toHaveBeenCalledWith({ removeRuleIds: [42] });
  });

  it('remove rejects when ruleId is missing', async () => {
    const res = await blockOrRedirectTool.execute({ action: 'remove' });
    expect(res.isError).toBe(true);
  });

  it('list returns the active session rules', async () => {
    sessionRules = [
      { id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'a' } },
      { id: 2, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'b' } },
    ];
    const body = parseBody(await blockOrRedirectTool.execute({ action: 'list' }));
    expect(body.count).toBe(2);
    expect(body.rules.length).toBe(2);
  });

  it('clear removes every active session rule', async () => {
    sessionRules = [
      { id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'a' } },
      { id: 7, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'b' } },
    ];
    const body = parseBody(await blockOrRedirectTool.execute({ action: 'clear' }));
    expect(updateMock).toHaveBeenCalledWith({ removeRuleIds: [1, 7] });
    expect(body.removed).toBe(2);
  });

  it('clear is a no-op when there are no rules', async () => {
    const body = parseBody(await blockOrRedirectTool.execute({ action: 'clear' }));
    expect(body.removed).toBe(0);
    // updateMock invoked once during the no-op? It shouldn't be called when ids is empty.
    expect(updateMock).not.toHaveBeenCalled();
  });
});
