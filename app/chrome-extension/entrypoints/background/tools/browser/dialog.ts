import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

/**
 * Default-dialog-handler behaviors. `accept` is the canonical answer for
 * confirm/prompt where the agent wants the page to proceed; `dismiss`
 * cancels. `prompt_with_text` only differs from `accept` for prompts:
 * the registered `promptText` is supplied as the user's input.
 */
type DefaultBehavior = 'accept' | 'dismiss' | 'prompt_with_text';

type DialogAction = 'handle_dialog' | 'register_default' | 'unregister_default' | 'list_defaults';

interface HandleDialogParams {
  /**
   * When omitted, the dispatcher treats this as the legacy one-shot
   * `handle_dialog` action so existing callers keep working unchanged.
   *
   * Accepts the new action enum (`handle_dialog` | `register_default` |
   * `unregister_default` | `list_defaults`) plus the legacy shorthand
   * (`accept` | `dismiss`) that older callers passed in this field as the
   * one-shot answer.
   */
  action?: DialogAction | 'accept' | 'dismiss';
  /** One-shot handler answer (legacy `handle_dialog`). */
  behavior?: 'accept' | 'dismiss';
  /**
   * For `register_default`. Same options as a one-shot answer, plus
   * `prompt_with_text` which forwards the configured `promptText` to the
   * page's prompt() return value.
   */
  defaultBehavior?: DefaultBehavior;
  promptText?: string;
  tabId?: number;
  windowId?: number;
}

/**
 * Per-tab record of a dialog the policy handled automatically. The most
 * recent N entries are surfaced via `list_defaults` so a caller can audit
 * which prompts fired while it wasn't watching.
 */
interface DialogLogEntry {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload' | string;
  message: string;
  defaultPrompt?: string;
  url?: string;
  behaviorApplied: DefaultBehavior;
  promptTextSent?: string;
  handledAt: number;
}

/**
 * Subset of `Page.javascriptDialogOpening` event params we surface in the
 * audit log. CDP returns more (frameId, hasBrowserHandler) — we ignore
 * those because callers can correlate dialogs by message/url/timestamp.
 */
interface DialogOpeningParams {
  type?: string;
  message?: string;
  defaultPrompt?: string;
  url?: string;
}

type DebuggerEventListener = (
  source: chrome.debugger.Debuggee,
  method: string,
  params?: unknown,
) => void;

interface DefaultPolicy {
  behavior: DefaultBehavior;
  promptText?: string;
  registeredAt: number;
  /**
   * Bound listener reference so we can `chrome.debugger.onEvent.removeListener`
   * exactly the function we attached when releasing the policy.
   */
  listener: DebuggerEventListener;
  log: DialogLogEntry[];
}

/** Cap on recorded auto-handled dialogs per tab. */
export const DIALOG_LOG_CAP = 50;

const OWNER_TAG = 'dialog-default';

/**
 * Module-scope registry. Tab close, client disconnect, and external CDP
 * detach all funnel through `clearDefaultForTab`, so the cleanup paths
 * agree on what "release" means.
 */
const defaults = new Map<number, DefaultPolicy>();

/**
 * onDetach handler installed once. If Chrome detaches the debugger out
 * from under us (DevTools opened, user revoked, tab crashed), drop the
 * policy and warn — the agent has no way to know auto-handle silently
 * stopped working otherwise.
 */
let onDetachInstalled = false;

function ensureDetachListener() {
  if (onDetachInstalled) return;
  if (typeof chrome === 'undefined' || !chrome.debugger?.onDetach?.addListener) return;
  chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source.tabId;
    if (typeof tabId !== 'number') return;
    if (!defaults.has(tabId)) return;
    console.warn(
      `[chrome_handle_dialog] CDP detached from tab ${tabId} (reason: ${reason}); clearing default policy.`,
    );
    // External detach — we only need to drop our bookkeeping. cdpSessionManager
    // has already cleared its own state via the same onDetach signal.
    const policy = defaults.get(tabId);
    if (policy) {
      try {
        chrome.debugger.onEvent.removeListener(policy.listener);
      } catch {
        // best-effort — onEvent may already have been torn down
      }
    }
    defaults.delete(tabId);
  });
  onDetachInstalled = true;
}

function buildLogEntry(
  policy: DefaultPolicy,
  params: DialogOpeningParams,
  promptTextSent: string | undefined,
): DialogLogEntry {
  return {
    type: typeof params?.type === 'string' ? params.type : 'unknown',
    message: typeof params?.message === 'string' ? params.message : '',
    defaultPrompt: typeof params?.defaultPrompt === 'string' ? params.defaultPrompt : undefined,
    url: typeof params?.url === 'string' ? params.url : undefined,
    behaviorApplied: policy.behavior,
    promptTextSent,
    handledAt: Date.now(),
  };
}

async function handleDialogEvent(tabId: number, params: DialogOpeningParams): Promise<void> {
  const policy = defaults.get(tabId);
  if (!policy) return;

  const accept = policy.behavior !== 'dismiss';
  const promptTextSent =
    policy.behavior === 'prompt_with_text' && accept ? (policy.promptText ?? '') : undefined;

  try {
    await cdpSessionManager.sendCommand(tabId, 'Page.handleJavaScriptDialog', {
      accept,
      ...(promptTextSent !== undefined ? { promptText: promptTextSent } : {}),
    });
  } catch (err) {
    console.warn(
      `[chrome_handle_dialog] Auto-handle failed for tab ${tabId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  policy.log.push(buildLogEntry(policy, params, promptTextSent));
  if (policy.log.length > DIALOG_LOG_CAP) {
    // Drop oldest; keep the most recent DIALOG_LOG_CAP.
    policy.log.splice(0, policy.log.length - DIALOG_LOG_CAP);
  }
}

async function clearDefaultForTab(tabId: number): Promise<boolean> {
  const policy = defaults.get(tabId);
  if (!policy) return false;
  try {
    chrome.debugger.onEvent.removeListener(policy.listener);
  } catch {
    // best-effort
  }
  defaults.delete(tabId);
  try {
    await cdpSessionManager.detach(tabId, OWNER_TAG);
  } catch (err) {
    console.warn(
      `[chrome_handle_dialog] Detach during unregister failed for tab ${tabId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return true;
}

/**
 * Drop every policy for tabs in `tabIds`. Returns the list actually
 * released (subset of input). Used by the dispatcher's per-client
 * disconnect hook in tools/index.ts so a client's policies don't outlive
 * its session.
 */
export async function releaseDialogDefaultsForTabs(tabIds: Iterable<number>): Promise<number[]> {
  const released: number[] = [];
  for (const tabId of tabIds) {
    if (await clearDefaultForTab(tabId)) released.push(tabId);
  }
  return released;
}

/**
 * Multi-action dialog tool.
 *
 * Actions:
 *   - `handle_dialog` (legacy; also the default when action is omitted):
 *     one-shot answer to a dialog that is currently open.
 *   - `register_default`: persist a per-tab auto-answer policy that
 *     subscribes `Page.javascriptDialogOpening` via a refcounted CDP
 *     attach. Calling `register_default` twice on the same tab replaces
 *     the prior policy without erroring.
 *   - `unregister_default`: release the policy + the CDP attach for the
 *     tab.
 *   - `list_defaults`: read-only — returns the registered policies (and
 *     the recent auto-handled dialog log per tab). `tabId` filters to one
 *     tab; omit to enumerate.
 *
 * Cost note: `register_default` holds an active `chrome.debugger` attach
 * for the lifetime of the policy, so the "Chrome is being controlled by
 * automated software" banner stays visible on the affected tab until
 * `unregister_default` (or tab close / client disconnect).
 */
class HandleDialogTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.HANDLE_DIALOG;

  async execute(args: HandleDialogParams): Promise<ToolResult> {
    ensureDetachListener();

    // Backward compat: the original surface accepted `action: 'accept'` or
    // `action: 'dismiss'` (which doubled as the one-shot behavior). Route
    // those through the legacy one-shot path before the action-enum match.
    const rawAction = args?.action;
    if (rawAction === 'accept' || rawAction === 'dismiss') {
      return this.handleOneShot(args);
    }

    const action: DialogAction = (rawAction as DialogAction | undefined) ?? 'handle_dialog';

    switch (action) {
      case 'handle_dialog':
        return this.handleOneShot(args);
      case 'register_default':
        return this.handleRegisterDefault(args);
      case 'unregister_default':
        return this.handleUnregisterDefault(args);
      case 'list_defaults':
        return this.handleListDefaults(args);
      default:
        return createErrorResponse(
          'action must be one of: handle_dialog, register_default, unregister_default, list_defaults',
          ToolErrorCode.INVALID_ARGS,
          { arg: 'action' },
        );
    }
  }

  private async resolveTabId(args: HandleDialogParams): Promise<number | { error: ToolResult }> {
    try {
      const explicit = await this.tryGetTab(args?.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args?.windowId));
      if (!tab.id) {
        return {
          error: createErrorResponse('No target tab found', ToolErrorCode.TAB_NOT_FOUND),
        };
      }
      return tab.id;
    } catch (err) {
      return {
        error: createErrorResponse(
          `Failed to resolve target tab: ${err instanceof Error ? err.message : String(err)}`,
          ToolErrorCode.TAB_NOT_FOUND,
        ),
      };
    }
  }

  private async handleOneShot(args: HandleDialogParams): Promise<ToolResult> {
    // Legacy callers passed the answer as `action: 'accept'|'dismiss'`. New
    // callers pass `behavior: 'accept'|'dismiss'` (optionally with explicit
    // `action: 'handle_dialog'`). Resolve in that order.
    const legacyAction =
      args?.action === 'accept' || args?.action === 'dismiss' ? args.action : undefined;
    const oneShot = (args?.behavior ?? legacyAction) as 'accept' | 'dismiss' | undefined;

    if (!oneShot || (oneShot !== 'accept' && oneShot !== 'dismiss')) {
      return createErrorResponse(
        'behavior must be "accept" or "dismiss"',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'behavior' },
      );
    }

    const resolved = await this.resolveTabId(args);
    if (typeof resolved !== 'number') return resolved.error;
    const tabId = resolved;

    try {
      await cdpSessionManager.withSession(tabId, 'dialog', async () => {
        await cdpSessionManager.sendCommand(tabId, 'Page.enable');
        await cdpSessionManager.sendCommand(tabId, 'Page.handleJavaScriptDialog', {
          accept: oneShot === 'accept',
          promptText: oneShot === 'accept' ? args?.promptText : undefined,
        });
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              action: 'handle_dialog',
              behavior: oneShot,
              promptText: args?.promptText || null,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Failed to handle dialog: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleRegisterDefault(args: HandleDialogParams): Promise<ToolResult> {
    const behavior = args?.defaultBehavior;
    if (behavior !== 'accept' && behavior !== 'dismiss' && behavior !== 'prompt_with_text') {
      return createErrorResponse(
        'defaultBehavior must be one of: accept, dismiss, prompt_with_text',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'defaultBehavior' },
      );
    }
    if (behavior === 'prompt_with_text' && typeof args?.promptText !== 'string') {
      return createErrorResponse(
        'promptText is required when defaultBehavior is "prompt_with_text"',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'promptText' },
      );
    }

    const resolved = await this.resolveTabId(args);
    if (typeof resolved !== 'number') return resolved.error;
    const tabId = resolved;

    // Re-registering on the same tab replaces the previous policy without
    // erroring. Drop the prior listener but keep the prior CDP attach
    // so refcount stays at 1 (we'll attach again below and the manager
    // refcount will reach 1 after the matching detach below it).
    const existing = defaults.get(tabId);
    if (existing) {
      try {
        chrome.debugger.onEvent.removeListener(existing.listener);
      } catch {
        // best-effort
      }
      defaults.delete(tabId);
      // Release the existing attach now; we'll re-attach as a fresh owner
      // below. Detach is refcounted, so this only actually detaches if no
      // other tool is using the CDP session on this tab.
      try {
        await cdpSessionManager.detach(tabId, OWNER_TAG);
      } catch {
        // best-effort
      }
    }

    try {
      // Persistent attach for the policy's lifetime. Page.enable is what
      // makes javascriptDialogOpening fire — must be issued AFTER attach.
      await cdpSessionManager.attach(tabId, OWNER_TAG);
      await cdpSessionManager.sendCommand(tabId, 'Page.enable');
    } catch (error) {
      // Roll back the attach if Page.enable failed mid-way.
      try {
        await cdpSessionManager.detach(tabId, OWNER_TAG);
      } catch {
        // best-effort
      }
      const message = error instanceof Error ? error.message : String(error);
      const code = /already attached|cannot attach|debugger.*attach/i.test(message)
        ? ToolErrorCode.CDP_BUSY
        : ToolErrorCode.UNKNOWN;
      return createErrorResponse(
        `Failed to register dialog default for tab ${tabId}: ${message}`,
        code,
        { tabId },
      );
    }

    const listener: DebuggerEventListener = (source, method, params) => {
      if (source.tabId !== tabId) return;
      if (method !== 'Page.javascriptDialogOpening') return;
      // Fire-and-forget; logged inside if it fails. Cast is safe — the
      // method gate above narrows `params` to the dialog event payload.
      void handleDialogEvent(tabId, (params ?? {}) as DialogOpeningParams);
    };
    chrome.debugger.onEvent.addListener(listener);

    const policy: DefaultPolicy = {
      behavior,
      promptText: behavior === 'prompt_with_text' ? args?.promptText : undefined,
      registeredAt: Date.now(),
      listener,
      log: [],
    };
    defaults.set(tabId, policy);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            action: 'register_default',
            tabId,
            behavior,
            promptText: policy.promptText ?? null,
            registeredAt: policy.registeredAt,
            replaced: !!existing,
            // Visible warning that this attaches the CDP debugger
            warning:
              'Persistent CDP attach — the "Chrome is being controlled by automated software" banner will be visible on this tab until unregister_default.',
          }),
        },
      ],
      isError: false,
    };
  }

  private async handleUnregisterDefault(args: HandleDialogParams): Promise<ToolResult> {
    const resolved = await this.resolveTabId(args);
    if (typeof resolved !== 'number') return resolved.error;
    const tabId = resolved;

    const released = await clearDefaultForTab(tabId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            action: 'unregister_default',
            tabId,
            released,
          }),
        },
      ],
      isError: false,
    };
  }

  private async handleListDefaults(args: HandleDialogParams): Promise<ToolResult> {
    const filterId = typeof args?.tabId === 'number' ? args.tabId : undefined;
    const entries: Array<{
      tabId: number;
      behavior: DefaultBehavior;
      promptText: string | null;
      registeredAt: number;
      log: DialogLogEntry[];
    }> = [];
    for (const [id, policy] of defaults) {
      if (filterId !== undefined && id !== filterId) continue;
      entries.push({
        tabId: id,
        behavior: policy.behavior,
        promptText: policy.promptText ?? null,
        registeredAt: policy.registeredAt,
        log: [...policy.log],
      });
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            action: 'list_defaults',
            count: entries.length,
            defaults: entries,
          }),
        },
      ],
      isError: false,
    };
  }
}

export const handleDialogTool = new HandleDialogTool();

/** Test-only — seed a default policy without going through the public register flow. */
export function _seedDialogDefaultForTest(
  tabId: number,
  policy: {
    behavior: DefaultBehavior;
    promptText?: string;
    registeredAt?: number;
    listener?: DebuggerEventListener;
    log?: DialogLogEntry[];
  },
): void {
  defaults.set(tabId, {
    behavior: policy.behavior,
    promptText: policy.promptText,
    registeredAt: policy.registeredAt ?? Date.now(),
    listener: policy.listener ?? (() => {}),
    log: policy.log ?? [],
  });
}

/** Test-only — clear the entire defaults registry. */
export function _resetDialogDefaultsForTest(): void {
  for (const policy of defaults.values()) {
    try {
      chrome.debugger.onEvent.removeListener(policy.listener);
    } catch {
      // best-effort
    }
  }
  defaults.clear();
}

/** Test-only — inspect a policy by tab id. */
export function _getDialogDefaultForTest(tabId: number): DefaultPolicy | undefined {
  return defaults.get(tabId);
}

/** Test-only — dispatch a synthetic javascriptDialogOpening event. */
export async function _dispatchDialogEventForTest(
  tabId: number,
  params: DialogOpeningParams,
): Promise<void> {
  await handleDialogEvent(tabId, params);
}

// --- Automatic Cleanup ---
//
// Tab close: drop the policy + release the CDP attach. We don't need to
// call chrome.debugger.detach explicitly because Chrome auto-detaches on
// tab close; clearing our bookkeeping is enough.
try {
  chrome.tabs?.onRemoved?.addListener((closedTabId) => {
    if (!defaults.has(closedTabId)) return;
    const policy = defaults.get(closedTabId);
    if (policy) {
      try {
        chrome.debugger.onEvent.removeListener(policy.listener);
      } catch {
        // best-effort
      }
    }
    defaults.delete(closedTabId);
  });
} catch {
  // non-extension test context — listener is best-effort
}
