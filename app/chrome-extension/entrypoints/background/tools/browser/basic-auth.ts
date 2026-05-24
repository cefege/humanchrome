import { createErrorResponse, classifyTabError, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

/**
 * chrome_basic_auth — IMP-0145.
 *
 * Autoresponder for HTTP Basic / Digest auth prompts. Many internal
 * corporate sites and staging environments sit behind 401-challenge
 * dialogs; the native auth UI can't be answered via
 * `chrome_handle_dialog` (that handles JS dialogs only). Today agents
 * stall indefinitely on the first auth-protected page.
 *
 * Implementation: CDP `Fetch.enable({handleAuthRequests:true})` then
 * a per-tab listener on `Fetch.authRequired` that matches by origin
 * and responds with `ProvideCredentials` or `Default` (Chrome shows
 * the native dialog as fallback for unmatched challenges).
 *
 * Passwords are stored in-memory only — never persisted to
 * `chrome.storage`, never echoed in `list` output, never logged.
 *
 * Actions:
 *   - `register` ({tabId?, origin, username, password, scheme?}):
 *     install a credential for an origin (or `"*"` wildcard).
 *     `scheme` ∈ {'basic','digest','any'} — default 'any'.
 *   - `unregister` ({tabId?, origin}): drop the credential for the
 *     origin. Disables Fetch + detaches CDP when the last credential
 *     goes.
 *   - `list` ({tabId?}): inspect registered origins WITHOUT
 *     passwords. Returns `{origin, scheme, hasCredential:true,
 *     matchCount}`.
 *   - `clear` ({tabId?}): drop all credentials on the tab.
 */

type Action = 'register' | 'unregister' | 'list' | 'clear';
type Scheme = 'basic' | 'digest' | 'any';

interface BasicAuthParams {
  action?: Action;
  tabId?: number;
  windowId?: number;
  origin?: string;
  username?: string;
  password?: string;
  scheme?: Scheme;
}

interface Credential {
  origin: string;
  username: string;
  password: string;
  scheme: Scheme;
  matchCount: number;
}

interface TabAuthState {
  credentials: Map<string, Credential>; // keyed by origin (lowercased, no trailing slash)
  cdpListener: (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: unknown,
  ) => void;
}

const OWNER = 'basic-auth' as const;
const TAB_STATE = new Map<number, TabAuthState>();

let tabRemovedListenerInstalled = false;
function installTabRemovedListenerOnce(): void {
  if (tabRemovedListenerInstalled) return;
  if (typeof chrome === 'undefined' || !chrome.tabs?.onRemoved?.addListener) return;
  chrome.tabs.onRemoved.addListener((tabId) => {
    teardownTabState(tabId).catch(() => {
      /* best-effort cleanup */
    });
  });
  tabRemovedListenerInstalled = true;
}

/** Test-only: clear all per-tab state + re-arm listeners. */
export function _resetBasicAuthForTests(): void {
  for (const state of TAB_STATE.values()) {
    try {
      chrome.debugger?.onEvent?.removeListener?.(state.cdpListener);
    } catch {
      /* ignore */
    }
  }
  TAB_STATE.clear();
  tabRemovedListenerInstalled = false;
}

class BasicAuthTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.BASIC_AUTH;
  static readonly mutates = true;

  async execute(args: BasicAuthParams = {}): Promise<ToolResult> {
    const action = args.action ?? 'register';
    if (!['register', 'unregister', 'list', 'clear'].includes(action)) {
      return createErrorResponse(
        `Invalid action "${action}": expected one of register|unregister|list|clear`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }

    installTabRemovedListenerOnce();

    let tab: chrome.tabs.Tab;
    try {
      tab = await this.getOwnedTab({ explicit: args.tabId, windowId: args.windowId });
    } catch (err) {
      return classifyTabError(err, { toolName: TOOL_NAMES.BROWSER.BASIC_AUTH });
    }
    const tabId = tab.id!;

    try {
      switch (action) {
        case 'list':
          return this.listCredentials(tabId);
        case 'unregister':
          return await this.unregisterCredential(tabId, args.origin);
        case 'clear':
          return await this.clearCredentials(tabId);
        case 'register':
        default:
          return await this.registerCredential(tabId, args);
      }
    } catch (e) {
      // Sanitize: never echo password in error envelopes.
      const raw = e instanceof Error ? e.message : String(e);
      const msg = redactPassword(raw, args.password);
      if (/another debugger|already attached/i.test(msg)) {
        return createErrorResponse(msg, ToolErrorCode.CDP_BUSY, { tabId });
      }
      return createErrorResponse(
        `chrome_basic_auth(${action}) failed: ${msg}`,
        ToolErrorCode.UNKNOWN,
        { tabId, action },
      );
    }
  }

  private listCredentials(tabId: number): ToolResult {
    const state = TAB_STATE.get(tabId);
    const entries = state
      ? Array.from(state.credentials.values()).map((c) => ({
          origin: c.origin,
          scheme: c.scheme,
          hasCredential: true,
          matchCount: c.matchCount,
        }))
      : [];
    return this.ok({ tabId, count: entries.length, credentials: entries });
  }

  private async unregisterCredential(tabId: number, origin?: string): Promise<ToolResult> {
    if (typeof origin !== 'string' || origin.length === 0) {
      return createErrorResponse(
        'origin is required (string)',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'origin' },
      );
    }
    const key = normalizeOrigin(origin);
    const state = TAB_STATE.get(tabId);
    if (!state || !state.credentials.has(key)) {
      return this.ok({ tabId, removed: false, origin: key });
    }
    state.credentials.delete(key);
    if (state.credentials.size === 0) {
      await teardownTabState(tabId);
    }
    return this.ok({ tabId, removed: true, origin: key });
  }

  private async clearCredentials(tabId: number): Promise<ToolResult> {
    const state = TAB_STATE.get(tabId);
    if (!state || state.credentials.size === 0) {
      return this.ok({ tabId, cleared: 0 });
    }
    const n = state.credentials.size;
    await teardownTabState(tabId);
    return this.ok({ tabId, cleared: n });
  }

  private async registerCredential(
    tabId: number,
    args: BasicAuthParams,
  ): Promise<ToolResult> {
    if (typeof args.origin !== 'string' || args.origin.length === 0) {
      return createErrorResponse(
        'origin is required (string, e.g. "https://example.com" or "*")',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'origin' },
      );
    }
    if (typeof args.username !== 'string' || args.username.length === 0) {
      return createErrorResponse(
        'username is required (string)',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'username' },
      );
    }
    if (typeof args.password !== 'string') {
      return createErrorResponse(
        'password is required (string)',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'password' },
      );
    }
    const scheme: Scheme = args.scheme ?? 'any';
    if (!['basic', 'digest', 'any'].includes(scheme)) {
      return createErrorResponse(
        `Invalid scheme "${scheme}": expected basic|digest|any`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'scheme' },
      );
    }
    const originKey = normalizeOrigin(args.origin);

    // First credential on this tab → CDP attach + Fetch.enable with
    // handleAuthRequests:true + install listener.
    let state = TAB_STATE.get(tabId);
    if (!state) {
      const cdpListener = (
        source: chrome.debugger.Debuggee,
        method: string,
        params?: unknown,
      ) => {
        if (source.tabId !== tabId) return;
        if (method !== 'Fetch.authRequired') return;
        handleAuthRequired(tabId, params as AuthRequiredParams).catch((err) => {
          console.warn(`chrome_basic_auth: handleAuthRequired failed`, err);
        });
      };
      chrome.debugger.onEvent.addListener(cdpListener);
      state = { credentials: new Map(), cdpListener };
      TAB_STATE.set(tabId, state);
      try {
        await cdpSessionManager.attach(tabId, OWNER);
        await cdpSessionManager.sendCommand(tabId, 'Fetch.enable', {
          handleAuthRequests: true,
          patterns: [{ requestStage: 'Request' }],
        });
      } catch (e) {
        chrome.debugger.onEvent.removeListener(cdpListener);
        TAB_STATE.delete(tabId);
        throw e;
      }
    }
    state.credentials.set(originKey, {
      origin: originKey,
      username: args.username,
      password: args.password,
      scheme,
      matchCount: 0,
    });

    // Do NOT echo the password in the response.
    return this.ok({
      tabId,
      origin: originKey,
      username: args.username,
      scheme,
      hasCredential: true,
    });
  }

  private ok(payload: Record<string, unknown>): ToolResult {
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, ...payload }) }],
      isError: false,
    };
  }
}

interface AuthRequiredParams {
  requestId: string;
  request: { url: string };
  authChallenge?: { origin?: string; scheme?: string; realm?: string };
}

async function handleAuthRequired(
  tabId: number,
  params: AuthRequiredParams,
): Promise<void> {
  const state = TAB_STATE.get(tabId);
  if (!state) return;

  // Pick the credential to use: exact origin match first, then "*"
  // wildcard, then no match (Default response — Chrome shows native dialog).
  const url = params.request?.url ?? '';
  const reqOrigin = originFromUrl(url);
  const challengeScheme = (params.authChallenge?.scheme ?? '').toLowerCase();

  let matched: Credential | undefined;
  const exact = state.credentials.get(reqOrigin);
  if (exact && schemeMatches(exact.scheme, challengeScheme)) matched = exact;
  if (!matched) {
    const wildcard = state.credentials.get('*');
    if (wildcard && schemeMatches(wildcard.scheme, challengeScheme)) matched = wildcard;
  }

  if (!matched) {
    try {
      await cdpSessionManager.sendCommand(tabId, 'Fetch.continueWithAuth', {
        requestId: params.requestId,
        authChallengeResponse: { response: 'Default' },
      });
    } catch {
      /* paused request may already be gone */
    }
    return;
  }

  matched.matchCount += 1;
  try {
    await cdpSessionManager.sendCommand(tabId, 'Fetch.continueWithAuth', {
      requestId: params.requestId,
      authChallengeResponse: {
        response: 'ProvideCredentials',
        username: matched.username,
        password: matched.password,
      },
    });
    // Log MATCHED only — never the password.
    console.warn(
      `chrome_basic_auth: matched ${matched.origin} (${matched.scheme}) for ${url}`,
    );
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const msg = redactPassword(raw, matched.password);
    console.warn(`chrome_basic_auth: continueWithAuth failed for ${matched.origin}: ${msg}`);
  }
}

async function teardownTabState(tabId: number): Promise<void> {
  const state = TAB_STATE.get(tabId);
  if (!state) return;
  TAB_STATE.delete(tabId);
  try {
    chrome.debugger?.onEvent?.removeListener?.(state.cdpListener);
  } catch {
    /* ignore */
  }
  try {
    await cdpSessionManager.sendCommand(tabId, 'Fetch.disable', {});
  } catch {
    /* attach already detached */
  }
  try {
    await cdpSessionManager.detach(tabId, OWNER);
  } catch {
    /* same */
  }
}

function normalizeOrigin(s: string): string {
  if (s === '*') return '*';
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return s.toLowerCase().replace(/\/+$/, '');
  }
}

function originFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return '';
  }
}

function schemeMatches(stored: Scheme, challenge: string): boolean {
  if (stored === 'any') return true;
  return stored === challenge;
}

function redactPassword(text: string, password?: string): string {
  if (!password) return text;
  return text.split(password).join('<redacted>');
}

export const basicAuthTool = new BasicAuthTool();
