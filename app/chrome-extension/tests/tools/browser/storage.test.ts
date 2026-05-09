/**
 * chrome_storage tests (IMP-0047).
 *
 * The tool wraps a MAIN-world chrome.scripting.executeScript shim that
 * reads/writes window.localStorage or window.sessionStorage. We
 * stub chrome.scripting.executeScript and run the actual storageShim
 * against a real fake-storage Storage object — that way we exercise
 * the shim implementation, the orchestrator's argument validation,
 * and the response shaping in one go without spinning up a content
 * script.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storageTool } from '@/entrypoints/background/tools/browser/storage';

type StorageAction = 'get' | 'set' | 'remove' | 'clear' | 'keys';
type StorageScope = 'local' | 'session';

class FakeStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }
}

let localStore: FakeStorage;
let sessionStore: FakeStorage;
let executeScriptMock: ReturnType<typeof vi.fn>;

/**
 * Faithful reimplementation of the executeScript path: extract the
 * `func` we passed in, run it inside a sandbox where window.localStorage
 * and window.sessionStorage point at our FakeStorages, and return the
 * `[{result}]` array Chrome would. Mirrors the real call shape so the
 * orchestrator code-path is genuinely exercised.
 */
function runShim(opts: { target: any; world: string; func: any; args: any[] }) {
  // Build the sandbox window for the shim closure.
  const win = { localStorage: localStore, sessionStorage: sessionStore };
  const fn = opts.func as (...a: any[]) => any;
  // Replace global `window` for the duration of the call.
  const originalWindow = (globalThis as any).window;
  (globalThis as any).window = win;
  try {
    const result = fn(...opts.args);
    return Promise.resolve([{ result }]);
  } finally {
    (globalThis as any).window = originalWindow;
  }
}

beforeEach(() => {
  localStore = new FakeStorage();
  sessionStore = new FakeStorage();
  executeScriptMock = vi.fn(runShim);
  (globalThis.chrome as any).scripting = {
    executeScript: executeScriptMock,
  };
  (globalThis.chrome as any).tabs.query = vi
    .fn()
    .mockResolvedValue([{ id: 7, url: 'https://example.com/' }]);
});

afterEach(() => {
  delete (globalThis.chrome as any).scripting;
});

function parse(res: any): any {
  return JSON.parse(res.content[0].text);
}

async function call(args: {
  action: StorageAction;
  scope?: StorageScope;
  key?: string;
  value?: string;
  tabId?: number;
  windowId?: number;
  frameId?: number;
}) {
  return storageTool.execute(args);
}

describe('chrome_storage — argument validation', () => {
  it('rejects an unknown action', async () => {
    const res = await call({ action: 'bogus' as any });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/INVALID_ARGS/);
  });

  it('requires key for action="get"', async () => {
    const res = await call({ action: 'get' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/INVALID_ARGS/);
  });

  it('requires key for action="set"', async () => {
    const res = await call({ action: 'set', value: 'v' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/INVALID_ARGS/);
  });

  it('requires value for action="set"', async () => {
    const res = await call({ action: 'set', key: 'k' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/INVALID_ARGS/);
  });

  it('requires key for action="remove"', async () => {
    const res = await call({ action: 'remove' });
    expect(res.isError).toBe(true);
  });
});

describe('chrome_storage — happy paths (localStorage default)', () => {
  it('set stores a string and returns ok+stored:true', async () => {
    const res = await call({ action: 'set', key: 'token', value: 'abc' });
    expect(res.isError).toBe(false);
    const body = parse(res);
    expect(body).toMatchObject({ ok: true, scope: 'local', action: 'set', stored: true });
    expect(localStore.getItem('token')).toBe('abc');
  });

  it('get returns {value, exists:true} when present', async () => {
    localStore.setItem('token', 'abc');
    const res = await call({ action: 'get', key: 'token' });
    const body = parse(res);
    expect(body).toMatchObject({ value: 'abc', exists: true });
  });

  it('get returns {value:null, exists:false} when absent', async () => {
    const res = await call({ action: 'get', key: 'missing' });
    const body = parse(res);
    expect(body).toMatchObject({ value: null, exists: false });
  });

  it('remove returns {removed:true} for an existing key and {removed:false} for an absent one', async () => {
    localStore.setItem('a', '1');

    const hit = parse(await call({ action: 'remove', key: 'a' }));
    expect(hit.removed).toBe(true);
    expect(localStore.getItem('a')).toBeNull();

    const miss = parse(await call({ action: 'remove', key: 'a' }));
    expect(miss.removed).toBe(false);
  });

  it('clear wipes all keys and reports the count cleared', async () => {
    localStore.setItem('a', '1');
    localStore.setItem('b', '2');
    localStore.setItem('c', '3');

    const body = parse(await call({ action: 'clear' }));
    expect(body.cleared).toBe(3);
    expect(localStore.length).toBe(0);
  });

  it('keys returns the list of stored keys', async () => {
    localStore.setItem('a', '1');
    localStore.setItem('b', '2');

    const body = parse(await call({ action: 'keys' }));
    expect(body.keys.sort()).toEqual(['a', 'b']);
  });
});

describe('chrome_storage — sessionStorage scope', () => {
  it('routes set to sessionStorage when scope is "session"', async () => {
    await call({ action: 'set', scope: 'session', key: 's', value: 'sv' });
    expect(sessionStore.getItem('s')).toBe('sv');
    expect(localStore.getItem('s')).toBeNull();
  });

  it('local and session are isolated from each other under matching keys', async () => {
    await call({ action: 'set', scope: 'local', key: 'shared', value: 'L' });
    await call({ action: 'set', scope: 'session', key: 'shared', value: 'S' });

    const local = parse(await call({ action: 'get', scope: 'local', key: 'shared' }));
    const session = parse(await call({ action: 'get', scope: 'session', key: 'shared' }));
    expect(local.value).toBe('L');
    expect(session.value).toBe('S');
  });
});

describe('chrome_storage — tab + frame routing', () => {
  it('forwards explicit tabId verbatim to chrome.scripting.executeScript', async () => {
    await call({ action: 'keys', tabId: 99 });
    expect(executeScriptMock).toHaveBeenCalledTimes(1);
    expect(executeScriptMock.mock.calls[0][0].target).toEqual({ tabId: 99 });
  });

  it('falls back to active tab when no tabId is given', async () => {
    await call({ action: 'keys' });
    expect(executeScriptMock.mock.calls[0][0].target).toEqual({ tabId: 7 });
  });

  it('threads frameId into target.frameIds', async () => {
    await call({ action: 'keys', tabId: 1, frameId: 42 });
    expect(executeScriptMock.mock.calls[0][0].target).toEqual({ tabId: 1, frameIds: [42] });
  });

  it('reports TAB_NOT_FOUND when no active tab exists', async () => {
    (globalThis.chrome as any).tabs.query = vi.fn().mockResolvedValue([]);
    const res = await call({ action: 'keys' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/TAB_NOT_FOUND/);
  });

  it('classifies "no tab with id" rejection as TAB_CLOSED', async () => {
    executeScriptMock.mockRejectedValueOnce(new Error('No tab with id: 99'));
    const res = await call({ action: 'keys', tabId: 99 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/TAB_CLOSED/);
  });

  it('classifies frame errors as INVALID_ARGS', async () => {
    executeScriptMock.mockRejectedValueOnce(new Error('No frame with frameId 999 in tab 1'));
    const res = await call({ action: 'keys', tabId: 1, frameId: 999 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/INVALID_ARGS/);
  });
});

describe('chrome_storage — shim failure surfaces', () => {
  it('returns ok:false from the shim as a structured error', async () => {
    executeScriptMock.mockResolvedValueOnce([
      { result: { ok: false, message: 'QuotaExceededError' } },
    ]);
    const res = await call({ action: 'set', key: 'k', value: 'v' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/QuotaExceededError/);
  });

  it('returns a structured error when the shim returned no result (frame blocked)', async () => {
    executeScriptMock.mockResolvedValueOnce([]);
    const res = await call({ action: 'keys', tabId: 1 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/no result/i);
  });
});
