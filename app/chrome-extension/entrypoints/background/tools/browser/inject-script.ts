import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { ExecutionWorld } from '@/common/constants';

// Bug #217: `chrome.scripting.executeScript` calls used to be unbounded —
// when a page silently absorbed the injection (e.g., freelancermap.de's
// SW intercepts MAIN-world script setup) the await would never settle,
// and the caller waited the full 120s MCP transport budget before getting
// a generic "Request timed out" error. The new internal budget surfaces
// the hang as a structured INJECTION_TIMEOUT in <=5s so the LLM caller
// can branch instead of burning a prompt-cache window per failed inject.
const INJECT_TIMEOUT_MS = 5_000;

// Bug #217: `chrome.scripting.executeScript({world:'MAIN', func: ...})`
// can resolve successfully even when the page's CSP refuses to evaluate
// the function — the per-frame failure surfaces in `result.error`, not
// as a thrown rejection. We pattern-match the message to flip the tool
// response from a false-positive `{injected:true}` to an INJECTION_FAILED
// error with `details.reason:'CSP_BLOCKED'` the caller can branch on.
// The strings come from real-world rejections we've captured against
// LinkedIn (`script-src 'strict-dynamic' 'nonce-…'`) and Gmail (`'unsafe-eval'`).
const CSP_PATTERN_RE =
  /content security policy|csp|unsafe-eval|strict-dynamic|script-src|refused to (evaluate|execute|run)/i;

class InjectTimeoutError extends Error {
  constructor(
    public phase: string,
    public timeoutMs: number,
  ) {
    super(`${phase} did not return within ${timeoutMs}ms`);
    this.name = 'InjectTimeoutError';
  }
}

function withInjectTimeout<T>(promise: Promise<T>, phase: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new InjectTimeoutError(phase, INJECT_TIMEOUT_MS)),
      INJECT_TIMEOUT_MS,
    );
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function isInjectTimeoutError(err: unknown): err is InjectTimeoutError {
  return err instanceof Error && err.name === 'InjectTimeoutError';
}

interface InjectionFrameError {
  result?: unknown;
  error?: { message?: string };
}

interface InjectFailure {
  success: false;
  reason: 'CSP_BLOCKED' | 'INJECTION_ERROR';
  message: string;
}

interface InjectSuccess {
  injected: true;
  success: true;
}

type InjectOutcome = InjectFailure | InjectSuccess;

function classifyFrameError(
  results: InjectionFrameError[] | undefined,
  phase: string,
): InjectFailure | undefined {
  const failed = results?.find((r) => r && r.error && r.error.message);
  if (!failed?.error?.message) return undefined;
  const message = failed.error.message;
  if (CSP_PATTERN_RE.test(message)) {
    return { success: false, reason: 'CSP_BLOCKED', message };
  }
  return { success: false, reason: 'INJECTION_ERROR', message: `${phase}: ${message}` };
}

// Each inject phase (bridge, MAIN-world inject, ISOLATED inject) shares the
// same pipeline: time-boxed executeScript, then classifyFrameError on the
// per-frame results. The verify call is intentionally NOT routed through
// here — it inspects `result === true` for the sentinel, not `result.error`.
async function runInjectStep<Args extends unknown[]>(
  injection: chrome.scripting.ScriptInjection<Args, unknown>,
  phase: string,
): Promise<InjectFailure | undefined> {
  const results = (await withInjectTimeout(
    chrome.scripting.executeScript(injection),
    phase,
  )) as InjectionFrameError[];
  return classifyFrameError(results, phase);
}

interface InjectScriptParam {
  url?: string;
  tabId?: number;
  windowId?: number;
  background?: boolean;
}
interface ScriptConfig {
  type: ExecutionWorld;
  jsScript: string;
}

// Map value carries the original ScriptConfig plus an injection timestamp,
// surfaced via chrome_list_injected_scripts (IMP-0041) so callers can age
// out long-lived injections or trace what was injected when.
interface InjectedTabEntry extends ScriptConfig {
  injectedAt: number;
}

interface SendCommandToInjectScriptToolParam {
  tabId?: number;
  eventName: string;
  payload?: string;
}

interface ListInjectedScriptsToolParam {
  tabId?: number;
}

const injectedTabs = new Map<number, InjectedTabEntry>();
class InjectScriptTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.INJECT_SCRIPT;
  static readonly mutates = true;

  async execute(args: InjectScriptParam & ScriptConfig): Promise<ToolResult> {
    try {
      const { url, type, jsScript, tabId, windowId, background = true } = args;
      let tab: chrome.tabs.Tab | undefined;

      if (!type || !jsScript) {
        return createErrorResponse('Param [type] and [jsScript] is required');
      }

      if (typeof tabId === 'number') {
        tab = await chrome.tabs.get(tabId);
      } else if (url) {
        // If URL is provided, check if it's already open
        console.log(`Checking if URL is already open: ${url}`);
        const allTabs = await chrome.tabs.query({});

        // Find tab with matching URL
        const matchingTabs = allTabs.filter((t) => {
          // Normalize URLs for comparison (remove trailing slashes)
          const tabUrl = t.url?.endsWith('/') ? t.url.slice(0, -1) : t.url;
          const targetUrl = url.endsWith('/') ? url.slice(0, -1) : url;
          return tabUrl === targetUrl;
        });

        if (matchingTabs.length > 0) {
          // Use existing tab
          tab = matchingTabs[0];
          console.log(`Found existing tab with URL: ${url}, tab ID: ${tab.id}`);
        } else {
          // Create new tab with the URL
          console.log(`No existing tab found with URL: ${url}, creating new tab`);
          tab = await chrome.tabs.create({
            url,
            active: background === true ? false : true,
            windowId,
          });

          // Wait for page to load
          console.log('Waiting for page to load...');
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      } else {
        // Use active tab (prefer the specified window)
        const tabs =
          typeof windowId === 'number'
            ? await chrome.tabs.query({ active: true, windowId })
            : await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]) {
          return createErrorResponse('No active tab found');
        }
        tab = tabs[0];
      }

      if (!tab.id) {
        return createErrorResponse('Tab has no ID');
      }

      // Optionally bring tab/window to foreground based on background flag
      if (background !== true) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      }

      const targetTabId = tab.id!;
      let res: InjectOutcome;
      try {
        res = await handleInject(targetTabId, { ...args });
      } catch (error) {
        if (isInjectTimeoutError(error)) {
          return createErrorResponse(error.message, ToolErrorCode.INJECTION_TIMEOUT, {
            tabId: targetTabId,
            phase: error.phase,
            timeoutMs: error.timeoutMs,
          });
        }
        throw error;
      }

      if (res.success === false) {
        return createErrorResponse(res.message, ToolErrorCode.INJECTION_FAILED, {
          tabId: targetTabId,
          reason: res.reason,
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(res),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in InjectScriptTool.execute:', error);
      return createErrorResponse(
        `Inject script error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

class SendCommandToInjectScriptTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SEND_COMMAND_TO_INJECT_SCRIPT;
  static readonly mutates = true;

  async execute(args: SendCommandToInjectScriptToolParam): Promise<ToolResult> {
    try {
      const { tabId, eventName, payload } = args;

      if (!eventName) {
        return createErrorResponse('Param [eventName] is required');
      }

      if (tabId) {
        const tabExists = await isTabExists(tabId);
        if (!tabExists) {
          return createErrorResponse('The tab:[tabId] is not exists');
        }
      }

      let finalTabId: number | undefined = tabId;

      if (finalTabId === undefined) {
        // Use active tab
        const tabs = await chrome.tabs.query({ active: true });
        if (!tabs[0]) {
          return createErrorResponse('No active tab found');
        }
        finalTabId = tabs[0].id;
      }

      if (!finalTabId) {
        return createErrorResponse('No active tab found');
      }

      const entry = injectedTabs.get(finalTabId);
      if (!entry) {
        throw new Error('No script injected in this tab.');
      }
      const result = await chrome.tabs.sendMessage(finalTabId, {
        action: eventName,
        payload,
        targetWorld: entry.type, // The bridge uses this to decide whether to forward to MAIN world.
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in InjectScriptTool.execute:', error);
      return createErrorResponse(
        `Inject script error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function isTabExists(tabId: number) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch (error) {
    // An error is thrown if the tab doesn't exist.
    return false;
  }
}

/**
 * @description Handles the injection of user scripts into a specific tab.
 * @param {number} tabId - The ID of the target tab.
 * @param {object} scriptConfig - The configuration object for the script.
 */
async function handleInject(tabId: number, scriptConfig: ScriptConfig): Promise<InjectOutcome> {
  if (injectedTabs.has(tabId)) {
    // If already injected, run cleanup first to ensure a clean state.
    console.log(`Tab ${tabId} already has injections. Cleaning up first.`);
    await handleCleanup(tabId);
  }
  const { type, jsScript } = scriptConfig;
  const hasMain = type === ExecutionWorld.MAIN;

  if (hasMain) {
    // Bridge is essential for MAIN-world communication and cleanup. Time-
    // boxed because the bridge ships via chrome.scripting.executeScript,
    // which can hang indefinitely when a page intercepts script setup
    // (e.g., a service worker that rewrites every executeScript hook).
    //
    // Bridge inject must classifyFrameError too — silent-success otherwise
    // (bridge listener never installs, MAIN-world inject claims success
    // because its sentinel runs in the user wrapper not the bridge, and
    // later send-command calls hang with no forwarder).
    const bridgeFailure = await runInjectStep(
      {
        target: { tabId },
        files: ['inject-scripts/inject-bridge.js'],
        world: ExecutionWorld.ISOLATED,
      },
      'bridge inject',
    );
    if (bridgeFailure) return bridgeFailure;

    // Stamp a per-call sentinel onto `window` ONCE the user code has run.
    // The follow-up verify call reads it back and confirms MAIN-world
    // execution actually happened. LinkedIn (`script-src 'strict-dynamic'`)
    // is the canonical case where chrome.scripting.executeScript resolves
    // with no `result.error` even though the wrapper never reaches eval —
    // without this round-trip the tool would return a false-positive
    // `{injected:true}` while no script ran. Bug #217.
    const ack = `__hc_inject_ack_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;

    const failure = await runInjectStep(
      {
        target: { tabId },
        func: (code: string, ackKey: string) => {
          new Function(code)();
          (window as unknown as Record<string, boolean>)[ackKey] = true;
        },
        args: [jsScript, ack],
        world: ExecutionWorld.MAIN,
      },
      'MAIN-world inject',
    );
    if (failure) return failure;

    // Verify the sentinel landed. If the wrapper was silently dropped
    // (CSP `strict-dynamic` rejecting extension MAIN-world scripts; SW
    // intercepting; iframe sandbox), chrome.scripting won't report an
    // error but the property will be missing. Read it via a pure arrow
    // function (no eval) so the verify itself can't be CSP-blocked the
    // same way the user code might be.
    const verify = (await withInjectTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        func: (ackKey) => Boolean((window as unknown as Record<string, boolean>)[ackKey]),
        args: [ack],
        world: ExecutionWorld.MAIN,
      }),
      'MAIN-world verify',
    )) as Array<{ result?: unknown }>;

    const ran = verify?.some((r) => r && r.result === true);
    if (!ran) {
      return {
        success: false,
        reason: 'CSP_BLOCKED',
        message:
          "MAIN-world script did not execute. The page's CSP likely refuses extension-injected scripts (e.g. `script-src 'strict-dynamic' 'nonce-...'`). Try chrome_javascript (CDP path) or chrome_inject_script with type:'ISOLATED'.",
      };
    }
  } else {
    const failure = await runInjectStep(
      {
        target: { tabId },
        func: (code: string) => new Function(code)(),
        args: [jsScript],
        world: ExecutionWorld.ISOLATED,
      },
      'ISOLATED-world inject',
    );
    if (failure) return failure;
  }

  injectedTabs.set(tabId, { ...scriptConfig, injectedAt: Date.now() });
  console.log(`Scripts successfully injected into tab ${tabId}.`);
  return { injected: true, success: true };
}

/**
 * @description Triggers the cleanup process in a specific tab.
 * @param {number} tabId - The ID of the target tab.
 */
async function handleCleanup(tabId: number) {
  if (!injectedTabs.has(tabId)) return;
  // Send cleanup signal. The bridge will forward it to the MAIN world.
  chrome.tabs
    .sendMessage(tabId, { type: 'humanchrome:cleanup' })
    .catch((err) =>
      console.warn(`Could not send cleanup message to tab ${tabId}. It might have been closed.`),
    );

  injectedTabs.delete(tabId);
  console.log(`Cleanup signal sent to tab ${tabId}. State cleared.`);
}

/**
 * Read-only enumeration of every tab that currently carries an injected
 * user script. Backs `chrome_list_injected_scripts` (IMP-0041). Pure
 * read of the same in-memory `injectedTabs` Map the inject/send-command
 * tools mutate — no chrome.* call, no permission needed beyond what
 * chrome_inject_script already declares.
 */
class ListInjectedScriptsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.LIST_INJECTED_SCRIPTS;

  async execute(args: ListInjectedScriptsToolParam): Promise<ToolResult> {
    const filterTabId = typeof args?.tabId === 'number' ? args.tabId : undefined;

    const items: Array<{
      tabId: number;
      world: ExecutionWorld;
      scriptLength: number;
      injectedAt: number;
    }> = [];

    for (const [tabId, entry] of injectedTabs) {
      if (filterTabId !== undefined && tabId !== filterTabId) continue;
      items.push({
        tabId,
        world: entry.type,
        scriptLength: typeof entry.jsScript === 'string' ? entry.jsScript.length : 0,
        injectedAt: entry.injectedAt,
      });
    }

    items.sort((a, b) => a.tabId - b.tabId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ injectedTabs: items, count: items.length }),
        },
      ],
      isError: false,
    };
  }
}

export interface RemoveInjectedScriptParams {
  tabId?: number;
}

/**
 * Tear down an injected user script (IMP-0029). Wraps the internal
 * `handleCleanup`, which was previously only reachable via tab close.
 * Returns `{ removed: boolean, tabId }`; `removed:false` means there was
 * nothing to remove, so callers that don't track state can call freely.
 */
class RemoveInjectedScriptTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.REMOVE_INJECTED_SCRIPT;
  static readonly mutates = true;

  async execute(args: RemoveInjectedScriptParams = {}): Promise<ToolResult> {
    let tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
    if (tabId === undefined) {
      try {
        const tab = await this.getActiveTabOrThrowInWindow();
        tabId = tab.id;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return createErrorResponse(msg, ToolErrorCode.TAB_NOT_FOUND);
      }
    }
    if (typeof tabId !== 'number') {
      return createErrorResponse('Active tab has no ID', ToolErrorCode.TAB_NOT_FOUND);
    }

    if (!injectedTabs.has(tabId)) {
      return jsonOk({ removed: false, tabId });
    }
    try {
      await handleCleanup(tabId);
      return jsonOk({ removed: true, tabId });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Tab raced closure between has-check and cleanup; the map entry was
      // still cleared, so report removed:true.
      if (/no tab with id/i.test(msg)) {
        return jsonOk({ removed: true, tabId });
      }
      return createErrorResponse(
        `chrome_remove_injected_script failed: ${msg}`,
        ToolErrorCode.UNKNOWN,
        { tabId },
      );
    }
  }
}

export const injectScriptTool = new InjectScriptTool();
export const listInjectedScriptsTool = new ListInjectedScriptsTool();
export const sendCommandToInjectScriptTool = new SendCommandToInjectScriptTool();
export const removeInjectedScriptTool = new RemoveInjectedScriptTool();

/** Test-only — seed the injectedTabs map without going through the public inject path. */
export function _seedInjectedTabForTest(
  tabId: number,
  entry: { type: ExecutionWorld; jsScript: string; injectedAt?: number },
): void {
  injectedTabs.set(tabId, {
    type: entry.type,
    jsScript: entry.jsScript,
    injectedAt: entry.injectedAt ?? Date.now(),
  });
}

// --- Automatic Cleanup Listeners ---
chrome.tabs.onRemoved.addListener((tabId) => {
  if (injectedTabs.has(tabId)) {
    console.log(`Tab ${tabId} closed. Cleaning up state.`);
    injectedTabs.delete(tabId);
  }
});
