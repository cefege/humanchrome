/**
 * chrome_handle_dialog tests (IMP-0100).
 *
 * Covers the multi-action surface: legacy one-shot `handle_dialog`,
 * the new `register_default` / `unregister_default` / `list_defaults`
 * actions, plus the per-tab cleanup hooks (tab close, client disconnect).
 *
 * CDP plumbing is exercised by mocking `cdpSessionManager` and
 * `chrome.debugger` — the tests synthesize `Page.javascriptDialogOpening`
 * events through the seeded listener and assert the handler answered them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn().mockResolvedValue({}),
    withSession: vi.fn(async (_tabId: number, _owner: string, fn: () => Promise<unknown>) => fn()),
  },
}));

import {
  handleDialogTool,
  releaseDialogDefaultsForTabs,
  _resetDialogDefaultsForTest,
  _getDialogDefaultForTest,
  _dispatchDialogEventForTest,
  DIALOG_LOG_CAP,
} from '@/entrypoints/background/tools/browser/dialog';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

const sendCommandMock = cdpSessionManager.sendCommand as unknown as ReturnType<typeof vi.fn>;
const attachMock = cdpSessionManager.attach as unknown as ReturnType<typeof vi.fn>;
const detachMock = cdpSessionManager.detach as unknown as ReturnType<typeof vi.fn>;
const withSessionMock = cdpSessionManager.withSession as unknown as ReturnType<typeof vi.fn>;

let onEventAddListener: ReturnType<typeof vi.fn>;
let onEventRemoveListener: ReturnType<typeof vi.fn>;
let registeredListeners: Array<
  (source: chrome.debugger.Debuggee, method: string, params?: any) => void
>;

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

function installTabsMock(activeTabId: number, knownTabIds: number[] = []) {
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    get: vi.fn(async (id: number) => {
      if (knownTabIds.includes(id) || id === activeTabId) {
        return { id, windowId: 1, url: 'https://example.com/' };
      }
      throw new Error(`No tab with id ${id}`);
    }),
    query: vi.fn(async () => [{ id: activeTabId, windowId: 1, url: 'https://example.com/' }]),
    onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
  };
}

beforeEach(() => {
  sendCommandMock.mockReset();
  sendCommandMock.mockResolvedValue({});
  attachMock.mockReset();
  attachMock.mockResolvedValue(undefined);
  detachMock.mockReset();
  detachMock.mockResolvedValue(undefined);
  withSessionMock.mockReset();
  withSessionMock.mockImplementation(
    async (_tabId: number, _owner: string, fn: () => Promise<unknown>) => fn(),
  );

  registeredListeners = [];
  onEventAddListener = vi.fn((listener: any) => {
    registeredListeners.push(listener);
  });
  onEventRemoveListener = vi.fn((listener: any) => {
    const idx = registeredListeners.indexOf(listener);
    if (idx >= 0) registeredListeners.splice(idx, 1);
  });

  (globalThis.chrome as any).debugger = {
    ...(globalThis.chrome as any).debugger,
    onEvent: {
      addListener: onEventAddListener,
      removeListener: onEventRemoveListener,
    },
    onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
  };

  installTabsMock(101, [42, 77, 11, 22]);
  _resetDialogDefaultsForTest();
});

afterEach(() => {
  _resetDialogDefaultsForTest();
});

describe('chrome_handle_dialog — legacy one-shot (handle_dialog)', () => {
  it('legacy two-field call (action="accept") still works', async () => {
    const res = await handleDialogTool.execute({ action: 'accept' as any });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.success).toBe(true);
    expect(body.behavior).toBe('accept');
    // Page.handleJavaScriptDialog was issued under withSession
    expect(withSessionMock).toHaveBeenCalledTimes(1);
    const handleCall = sendCommandMock.mock.calls.find(
      (c) => c[1] === 'Page.handleJavaScriptDialog',
    );
    expect(handleCall?.[2]).toMatchObject({ accept: true });
  });

  it('new explicit shape (action="handle_dialog", behavior="dismiss") works', async () => {
    const res = await handleDialogTool.execute({
      action: 'handle_dialog',
      behavior: 'dismiss',
    });
    expect(res.isError).toBe(false);
    expect(parseBody(res).behavior).toBe('dismiss');
    const handleCall = sendCommandMock.mock.calls.find(
      (c) => c[1] === 'Page.handleJavaScriptDialog',
    );
    expect(handleCall?.[2]).toMatchObject({ accept: false });
  });

  it('forwards promptText when accepting', async () => {
    await handleDialogTool.execute({
      action: 'handle_dialog',
      behavior: 'accept',
      promptText: 'hello',
    });
    const handleCall = sendCommandMock.mock.calls.find(
      (c) => c[1] === 'Page.handleJavaScriptDialog',
    );
    expect(handleCall?.[2]).toMatchObject({ accept: true, promptText: 'hello' });
  });

  it('rejects invalid behavior with INVALID_ARGS', async () => {
    const res = await handleDialogTool.execute({
      action: 'handle_dialog',
      behavior: 'frobnicate' as any,
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('behavior');
  });
});

describe('chrome_handle_dialog — register_default', () => {
  it('validates defaultBehavior', async () => {
    const res = await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'nope' as any,
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('defaultBehavior');
  });

  it('requires promptText when defaultBehavior is prompt_with_text', async () => {
    const res = await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'prompt_with_text',
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('promptText');
  });

  it('attaches CDP, enables Page domain, and installs a listener', async () => {
    const res = await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'accept',
      tabId: 42,
    });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.action).toBe('register_default');
    expect(body.tabId).toBe(42);
    expect(body.behavior).toBe('accept');
    expect(body.warning).toMatch(/Chrome is being controlled/);
    expect(attachMock).toHaveBeenCalledWith(42, 'dialog-default');
    const pageEnable = sendCommandMock.mock.calls.find((c) => c[1] === 'Page.enable');
    expect(pageEnable?.[0]).toBe(42);
    expect(onEventAddListener).toHaveBeenCalledTimes(1);
    expect(_getDialogDefaultForTest(42)?.behavior).toBe('accept');
  });

  it('auto-handles a synthetic javascriptDialogOpening event with accept', async () => {
    await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'accept',
      tabId: 42,
    });
    sendCommandMock.mockClear();
    await _dispatchDialogEventForTest(42, {
      type: 'confirm',
      message: 'Are you sure?',
      url: 'https://example.com/',
    });
    const handleCall = sendCommandMock.mock.calls.find(
      (c) => c[1] === 'Page.handleJavaScriptDialog',
    );
    expect(handleCall).toBeDefined();
    expect(handleCall?.[2]).toMatchObject({ accept: true });
    expect(handleCall?.[2]).not.toHaveProperty('promptText');
    const policy = _getDialogDefaultForTest(42);
    expect(policy?.log).toHaveLength(1);
    expect(policy?.log[0]).toMatchObject({
      type: 'confirm',
      message: 'Are you sure?',
      behaviorApplied: 'accept',
    });
  });

  it('answers prompts with the configured promptText when behavior=prompt_with_text', async () => {
    await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'prompt_with_text',
      promptText: 'auto-input',
      tabId: 42,
    });
    sendCommandMock.mockClear();
    await _dispatchDialogEventForTest(42, {
      type: 'prompt',
      message: 'Enter name:',
      defaultPrompt: '',
    });
    const handleCall = sendCommandMock.mock.calls.find(
      (c) => c[1] === 'Page.handleJavaScriptDialog',
    );
    expect(handleCall?.[2]).toMatchObject({ accept: true, promptText: 'auto-input' });
    const policy = _getDialogDefaultForTest(42);
    expect(policy?.log[0]?.promptTextSent).toBe('auto-input');
  });

  it('answers with dismiss when behavior=dismiss', async () => {
    await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'dismiss',
      tabId: 42,
    });
    sendCommandMock.mockClear();
    await _dispatchDialogEventForTest(42, { type: 'confirm', message: 'really?' });
    const handleCall = sendCommandMock.mock.calls.find(
      (c) => c[1] === 'Page.handleJavaScriptDialog',
    );
    expect(handleCall?.[2]).toMatchObject({ accept: false });
  });

  it('replaces an existing policy on re-register without erroring', async () => {
    const first = await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'accept',
      tabId: 42,
    });
    expect(first.isError).toBe(false);
    expect(parseBody(first).replaced).toBe(false);

    const second = await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'dismiss',
      tabId: 42,
    });
    expect(second.isError).toBe(false);
    const body = parseBody(second);
    expect(body.replaced).toBe(true);
    expect(body.behavior).toBe('dismiss');
    // Two attaches (one per register), and the second register detached
    // the first before re-attaching, leaving exactly one active.
    expect(attachMock).toHaveBeenCalledTimes(2);
    expect(detachMock).toHaveBeenCalledTimes(1);
    // Listener swap — the OLD listener was removed, NEW one is active.
    expect(_getDialogDefaultForTest(42)?.behavior).toBe('dismiss');
  });

  it('caps the per-tab dialog log at DIALOG_LOG_CAP, dropping oldest', async () => {
    await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'accept',
      tabId: 42,
    });
    const total = DIALOG_LOG_CAP + 7;
    for (let i = 0; i < total; i++) {
      await _dispatchDialogEventForTest(42, {
        type: 'alert',
        message: `dialog #${i}`,
      });
    }
    const policy = _getDialogDefaultForTest(42);
    expect(policy?.log).toHaveLength(DIALOG_LOG_CAP);
    // Oldest dropped — first entry should be index 7
    expect(policy?.log[0]?.message).toBe('dialog #7');
    expect(policy?.log[DIALOG_LOG_CAP - 1]?.message).toBe(`dialog #${total - 1}`);
  });

  it('classifies CDP-busy attach failures as CDP_BUSY', async () => {
    attachMock.mockRejectedValueOnce(new Error('Another debugger is already attached'));
    const res = await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'accept',
      tabId: 42,
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('CDP_BUSY');
  });
});

describe('chrome_handle_dialog — unregister_default', () => {
  it('releases the policy and detaches CDP', async () => {
    await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'accept',
      tabId: 42,
    });
    expect(_getDialogDefaultForTest(42)).toBeDefined();

    const res = await handleDialogTool.execute({
      action: 'unregister_default',
      tabId: 42,
    });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.released).toBe(true);
    expect(_getDialogDefaultForTest(42)).toBeUndefined();
    expect(detachMock).toHaveBeenCalledWith(42, 'dialog-default');
    expect(onEventRemoveListener).toHaveBeenCalled();
  });

  it('reports released=false for an unknown tab without erroring', async () => {
    const res = await handleDialogTool.execute({
      action: 'unregister_default',
      tabId: 999,
    });
    expect(res.isError).toBe(false);
    expect(parseBody(res).released).toBe(false);
  });
});

describe('chrome_handle_dialog — list_defaults', () => {
  it('returns an empty list when nothing is registered', async () => {
    const res = await handleDialogTool.execute({ action: 'list_defaults' });
    expect(res.isError).toBe(false);
    const body = parseBody(res);
    expect(body.count).toBe(0);
    expect(body.defaults).toEqual([]);
  });

  it('enumerates per-tab policies and their recent dialog log', async () => {
    await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'accept',
      tabId: 11,
    });
    await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'dismiss',
      tabId: 22,
    });
    await _dispatchDialogEventForTest(11, { type: 'alert', message: 'on 11' });

    const res = await handleDialogTool.execute({ action: 'list_defaults' });
    const body = parseBody(res);
    expect(body.count).toBe(2);
    const byTab = Object.fromEntries((body.defaults as any[]).map((d) => [d.tabId, d]));
    expect(byTab[11].behavior).toBe('accept');
    expect(byTab[11].log).toHaveLength(1);
    expect(byTab[11].log[0].message).toBe('on 11');
    expect(byTab[22].behavior).toBe('dismiss');
    expect(byTab[22].log).toHaveLength(0);
  });

  it('filters by tabId when provided', async () => {
    await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'accept',
      tabId: 11,
    });
    await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'dismiss',
      tabId: 22,
    });
    const res = await handleDialogTool.execute({ action: 'list_defaults', tabId: 22 });
    const body = parseBody(res);
    expect(body.count).toBe(1);
    expect(body.defaults[0].tabId).toBe(22);
  });
});

describe('chrome_handle_dialog — cleanup hooks', () => {
  it('releaseDialogDefaultsForTabs drops policies and detaches CDP', async () => {
    await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'accept',
      tabId: 42,
    });
    await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'dismiss',
      tabId: 77,
    });
    detachMock.mockClear();

    const released = await releaseDialogDefaultsForTabs([42, 77, 999]);
    expect(released.sort()).toEqual([42, 77]);
    expect(_getDialogDefaultForTest(42)).toBeUndefined();
    expect(_getDialogDefaultForTest(77)).toBeUndefined();
    expect(detachMock).toHaveBeenCalledWith(42, 'dialog-default');
    expect(detachMock).toHaveBeenCalledWith(77, 'dialog-default');
  });

  it('rejects unknown action with INVALID_ARGS', async () => {
    const res = await handleDialogTool.execute({ action: 'frobnicate' as any });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('INVALID_ARGS');
  });

  it('warns and stops auto-handling when sendCommand throws', async () => {
    await handleDialogTool.execute({
      action: 'register_default',
      defaultBehavior: 'accept',
      tabId: 42,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendCommandMock.mockRejectedValueOnce(new Error('cdp gone'));
    await _dispatchDialogEventForTest(42, { type: 'alert', message: 'boom' });
    // Auto-handle failed — log entry NOT appended
    expect(_getDialogDefaultForTest(42)?.log).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
