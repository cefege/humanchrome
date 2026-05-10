import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { ExecutionWorld } from '@/common/constants';

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

      const res = await handleInject(tab.id!, { ...args });

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
async function handleInject(tabId: number, scriptConfig: ScriptConfig) {
  if (injectedTabs.has(tabId)) {
    // If already injected, run cleanup first to ensure a clean state.
    console.log(`Tab ${tabId} already has injections. Cleaning up first.`);
    await handleCleanup(tabId);
  }
  const { type, jsScript } = scriptConfig;
  const hasMain = type === ExecutionWorld.MAIN;

  if (hasMain) {
    // The bridge is essential for MAIN world communication and cleanup.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['inject-scripts/inject-bridge.js'],
      world: ExecutionWorld.ISOLATED,
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (code) => new Function(code)(),
      args: [jsScript],
      world: ExecutionWorld.MAIN,
    });
  } else {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (code) => new Function(code)(),
      args: [jsScript],
      world: ExecutionWorld.ISOLATED,
    });
  }
  injectedTabs.set(tabId, { ...scriptConfig, injectedAt: Date.now() });
  console.log(`Scripts successfully injected into tab ${tabId}.`);
  return { injected: true };
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
