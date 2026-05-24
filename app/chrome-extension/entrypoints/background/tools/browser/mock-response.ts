import { createErrorResponse, classifyTabError, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { compilePattern } from './intercept-response';

/**
 * chrome_mock_response — IMP-0128.
 *
 * Synthesize fake response bodies for matched URLs via CDP
 * `Fetch.enable` + `Fetch.requestPaused` + `Fetch.fulfillRequest`.
 * The page fires its real request; this tool intercepts the
 * pre-flight and returns a synthesized response before the network
 * layer ever leaves the browser.
 *
 * Common needs this closes:
 *   - Test the logged-in flow when the real endpoint would 429 →
 *     register a fake 200.
 *   - Deterministic fixture replay across runs.
 *   - Make a demo flow work when the back-end is down.
 *
 * Today `chrome_block_or_redirect` can drop or rewrite URLs; this is
 * the missing in-flight synthesis primitive.
 *
 * Actions:
 *   - `register` ({tabId?, urlPattern, method?, status?=200, headers?,
 *     body?, bodyJson?, delayMs?, once?=true}): install a handler that
 *     matches the next (or every) request whose URL+method satisfy the
 *     pattern. `bodyJson` auto-serializes + sets `content-type:
 *     application/json` if no `content-type` is in `headers`. `once`
 *     auto-unregisters after the first match. Returns `{handlerId,
 *     urlPattern, method, status}`.
 *   - `list_mocks` ({tabId?}): list registered handlers on the tab.
 *   - `unregister_mock` ({tabId?, handlerId}): drop a specific
 *     handler. Disables Fetch when the last handler goes.
 *   - `clear` ({tabId?}): unregister all handlers on the tab.
 *
 * Pattern syntax (shared with intercept-response):
 *   "voyager/api"               → substring match
 *   "/voyager\\/api\\/.*foo/i" → regex match (slashes + flags)
 *
 * Output cap: response `body` is sent verbatim through CDP — Chrome
 * itself has no per-request size cap on Fetch.fulfillRequest, but
 * callers should keep mocks under 1 MiB to mirror the project-wide
 * response-body convention.
 */

type Action = 'register' | 'list_mocks' | 'unregister_mock' | 'clear';

interface MockResponseParams {
  action?: Action;
  tabId?: number;
  windowId?: number;
  // register
  urlPattern?: string;
  method?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  bodyJson?: unknown;
  delayMs?: number;
  once?: boolean;
  // unregister_mock
  handlerId?: string;
}

interface MockHandler {
  handlerId: string;
  urlPattern: string;
  method?: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  delayMs: number;
  once: boolean;
  matchCount: number;
  matcher: (url: string) => boolean;
}

interface TabMockState {
  handlers: Map<string, MockHandler>;
  cdpListener: (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: unknown,
  ) => void;
}

const OWNER = 'mock-response' as const;
const TAB_STATE = new Map<number, TabMockState>();
let handlerCounter = 0;

let tabRemovedListenerInstalled = false;
function installTabRemovedListenerOnce(): void {
  if (tabRemovedListenerInstalled) return;
  if (typeof chrome === 'undefined' || !chrome.tabs?.onRemoved?.addListener) return;
  chrome.tabs.onRemoved.addListener((tabId) => {
    teardownTabState(tabId).catch(() => {
      /* tab is gone — best-effort cleanup */
    });
  });
  tabRemovedListenerInstalled = true;
}

/** Test-only: clear all per-tab state + re-arm the onRemoved listener. */
export function _resetMockResponseForTests(): void {
  for (const state of TAB_STATE.values()) {
    try {
      chrome.debugger?.onEvent?.removeListener?.(state.cdpListener);
    } catch {
      /* ignore */
    }
  }
  TAB_STATE.clear();
  handlerCounter = 0;
  tabRemovedListenerInstalled = false;
}

class MockResponseTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.MOCK_RESPONSE;
  static readonly mutates = true;

  async execute(args: MockResponseParams = {}): Promise<ToolResult> {
    const action = args.action ?? 'register';
    if (!['register', 'list_mocks', 'unregister_mock', 'clear'].includes(action)) {
      return createErrorResponse(
        `Invalid action "${action}": expected one of register|list_mocks|unregister_mock|clear`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }

    installTabRemovedListenerOnce();

    let tab: chrome.tabs.Tab;
    try {
      tab = await this.getOwnedTab({ explicit: args.tabId, windowId: args.windowId });
    } catch (err) {
      return classifyTabError(err, { toolName: TOOL_NAMES.BROWSER.MOCK_RESPONSE });
    }
    const tabId = tab.id!;

    try {
      switch (action) {
        case 'list_mocks':
          return this.listMocks(tabId);
        case 'unregister_mock':
          return this.unregisterMock(tabId, args.handlerId);
        case 'clear':
          return this.clearMocks(tabId);
        case 'register':
        default:
          return await this.registerMock(tabId, args);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/another debugger|already attached/i.test(msg)) {
        return createErrorResponse(msg, ToolErrorCode.CDP_BUSY, { tabId });
      }
      return createErrorResponse(
        `chrome_mock_response(${action}) failed: ${msg}`,
        ToolErrorCode.UNKNOWN,
        { tabId, action },
      );
    }
  }

  private listMocks(tabId: number): ToolResult {
    const state = TAB_STATE.get(tabId);
    const mocks = state
      ? Array.from(state.handlers.values()).map((h) => ({
          handlerId: h.handlerId,
          urlPattern: h.urlPattern,
          method: h.method,
          status: h.status,
          once: h.once,
          matchCount: h.matchCount,
        }))
      : [];
    return this.ok({ tabId, count: mocks.length, mocks });
  }

  private async unregisterMock(tabId: number, handlerId?: string): Promise<ToolResult> {
    if (typeof handlerId !== 'string' || handlerId.length === 0) {
      return createErrorResponse(
        'handlerId is required (string)',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'handlerId' },
      );
    }
    const state = TAB_STATE.get(tabId);
    if (!state || !state.handlers.has(handlerId)) {
      return this.ok({ tabId, removed: false, handlerId });
    }
    state.handlers.delete(handlerId);
    if (state.handlers.size === 0) {
      await teardownTabState(tabId);
    }
    return this.ok({ tabId, removed: true, handlerId });
  }

  private async clearMocks(tabId: number): Promise<ToolResult> {
    const state = TAB_STATE.get(tabId);
    if (!state || state.handlers.size === 0) {
      return this.ok({ tabId, cleared: 0 });
    }
    const n = state.handlers.size;
    await teardownTabState(tabId);
    return this.ok({ tabId, cleared: n });
  }

  private async registerMock(
    tabId: number,
    args: MockResponseParams,
  ): Promise<ToolResult> {
    if (typeof args.urlPattern !== 'string' || args.urlPattern.length === 0) {
      return createErrorResponse(
        'urlPattern is required for action:"register"',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'urlPattern' },
      );
    }
    if (args.body !== undefined && args.bodyJson !== undefined) {
      return createErrorResponse(
        'Exactly one of [body] or [bodyJson] is allowed',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'body|bodyJson' },
      );
    }
    const status =
      typeof args.status === 'number' && Number.isFinite(args.status) ? Math.floor(args.status) : 200;
    const headers: Record<string, string> = { ...(args.headers ?? {}) };
    let body = '';
    if (args.bodyJson !== undefined) {
      body = JSON.stringify(args.bodyJson);
      // Only set the default content-type if caller didn't provide one
      // (case-insensitive — match what the CDP layer will see on the wire).
      const hasContentType = Object.keys(headers).some(
        (k) => k.toLowerCase() === 'content-type',
      );
      if (!hasContentType) headers['Content-Type'] = 'application/json';
    } else if (typeof args.body === 'string') {
      body = args.body;
    }

    const matcher = compilePattern(args.urlPattern);
    const handlerId = `mock_${++handlerCounter}_${Math.random().toString(36).slice(2, 8)}`;
    const handler: MockHandler = {
      handlerId,
      urlPattern: args.urlPattern,
      method: args.method ? args.method.toUpperCase() : undefined,
      status,
      headers,
      body,
      delayMs: typeof args.delayMs === 'number' && args.delayMs > 0 ? Math.floor(args.delayMs) : 0,
      once: args.once !== false,
      matchCount: 0,
      matcher,
    };

    // First handler on this tab → CDP attach + Fetch.enable + install listener.
    let state = TAB_STATE.get(tabId);
    if (!state) {
      const cdpListener = (
        source: chrome.debugger.Debuggee,
        method: string,
        params?: unknown,
      ) => {
        if (source.tabId !== tabId) return;
        if (method !== 'Fetch.requestPaused') return;
        handleRequestPaused(tabId, params as RequestPausedParams).catch((err) => {
          console.warn(`chrome_mock_response: handleRequestPaused failed`, err);
        });
      };
      chrome.debugger.onEvent.addListener(cdpListener);
      state = { handlers: new Map(), cdpListener };
      TAB_STATE.set(tabId, state);
      // Attach + Fetch.enable on first registration. patternFilter is
      // omitted — we filter in the listener so per-handler patterns
      // can change without re-issuing Fetch.enable.
      try {
        await cdpSessionManager.attach(tabId, OWNER);
        await cdpSessionManager.sendCommand(tabId, 'Fetch.enable', {
          patterns: [{ requestStage: 'Request' }],
        });
      } catch (e) {
        // Roll back state so the next call retries the attach cleanly.
        chrome.debugger.onEvent.removeListener(cdpListener);
        TAB_STATE.delete(tabId);
        throw e;
      }
    }
    state.handlers.set(handlerId, handler);

    return this.ok({
      tabId,
      handlerId,
      urlPattern: handler.urlPattern,
      method: handler.method ?? null,
      status: handler.status,
      once: handler.once,
    });
  }

  private ok(payload: Record<string, unknown>): ToolResult {
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, ...payload }) }],
      isError: false,
    };
  }
}

interface RequestPausedParams {
  requestId: string;
  request: { url: string; method: string };
  resourceType?: string;
  responseStatusCode?: number;
}

async function handleRequestPaused(
  tabId: number,
  params: RequestPausedParams,
): Promise<void> {
  const state = TAB_STATE.get(tabId);
  if (!state) return;

  // Find the first handler that matches; iterating in insertion order
  // gives caller-predictable precedence.
  let matched: MockHandler | undefined;
  for (const h of state.handlers.values()) {
    if (h.method && h.method !== params.request.method.toUpperCase()) continue;
    if (h.matcher(params.request.url)) {
      matched = h;
      break;
    }
  }

  if (!matched) {
    // No match — let the request continue normally.
    try {
      await cdpSessionManager.sendCommand(tabId, 'Fetch.continueRequest', {
        requestId: params.requestId,
      });
    } catch {
      /* paused request may already be gone if the tab navigated */
    }
    return;
  }

  matched.matchCount += 1;

  if (matched.delayMs > 0) {
    await new Promise((r) => setTimeout(r, matched.delayMs));
  }

  // Fetch.fulfillRequest takes a base64-encoded body and an array of
  // header objects. Encode the body as UTF-8 → base64 (the SW has
  // no Node Buffer; TextEncoder + btoa-style fallback works in both
  // Chrome and Node).
  const responseHeaders = Object.entries(matched.headers).map(([name, value]) => ({
    name,
    value,
  }));
  const base64Body = utf8ToBase64(matched.body);
  try {
    await cdpSessionManager.sendCommand(tabId, 'Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: matched.status,
      responseHeaders,
      body: base64Body,
    });
    console.warn(
      `chrome_mock_response: matched ${matched.handlerId} → ${matched.status} on ${params.request.url}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`chrome_mock_response: fulfillRequest failed for ${matched.handlerId}: ${msg}`);
  }

  if (matched.once) {
    state.handlers.delete(matched.handlerId);
    if (state.handlers.size === 0) {
      await teardownTabState(tabId);
    }
  }
}

async function teardownTabState(tabId: number): Promise<void> {
  const state = TAB_STATE.get(tabId);
  if (!state) return;
  TAB_STATE.delete(tabId);
  try {
    chrome.debugger?.onEvent?.removeListener?.(state.cdpListener);
  } catch {
    /* listener may already be gone */
  }
  try {
    await cdpSessionManager.sendCommand(tabId, 'Fetch.disable', {});
  } catch {
    /* attach may already be detached if tab closed */
  }
  try {
    await cdpSessionManager.detach(tabId, OWNER);
  } catch {
    /* same */
  }
}

function utf8ToBase64(s: string): string {
  // SW `btoa` only handles Latin-1; encode UTF-8 → bytes → Latin-1
  // string → btoa. Works in browser + SW + Node 16+ environments.
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export const mockResponseTool = new MockResponseTool();
