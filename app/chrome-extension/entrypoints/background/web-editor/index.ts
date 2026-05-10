/**
 * Web-editor background entry — orchestrator only (IMP-0034).
 *
 * Sets up the lifecycle hooks (context menu, keyboard command, tab cleanup)
 * and delegates the message dispatch to ./message-router. The previous
 * monolithic 768-LoC file mixed those concerns; the message handler alone
 * was ~700 LoC.
 */
import {
  CONTEXT_MENU_ID,
  ensureContextMenu,
  getActiveTabId,
  toggleEditorInTab,
} from './editor-lifecycle';
import { registerWebEditorMessageRouter } from './message-router';

const COMMAND_KEY = 'toggle_web_editor';

const WEB_EDITOR_TX_CHANGED_SESSION_KEY_PREFIX = 'web-editor-v2-tx-changed-';
const WEB_EDITOR_SELECTION_SESSION_KEY_PREFIX = 'web-editor-v2-selection-';
const WEB_EDITOR_EXCLUDED_KEYS_SESSION_KEY_PREFIX = 'web-editor-v2-excluded-keys-';

export function initWebEditorListeners(): void {
  ensureContextMenu().catch(() => {});

  // Clean up session storage when tab is closed to avoid stale data
  chrome.tabs.onRemoved.addListener((tabId) => {
    try {
      const keys = [
        `${WEB_EDITOR_TX_CHANGED_SESSION_KEY_PREFIX}${tabId}`,
        `${WEB_EDITOR_SELECTION_SESSION_KEY_PREFIX}${tabId}`,
        `${WEB_EDITOR_EXCLUDED_KEYS_SESSION_KEY_PREFIX}${tabId}`,
      ];
      chrome.storage.session.remove(keys).catch(() => {});
    } catch {}
  });

  if (chrome.contextMenus?.onClicked?.addListener) {
    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
      try {
        if (info.menuItemId !== CONTEXT_MENU_ID) return;
        const tabId = tab?.id;
        if (typeof tabId !== 'number') return;
        await toggleEditorInTab(tabId);
      } catch {}
    });
  }

  chrome.commands.onCommand.addListener(async (command) => {
    try {
      if (command !== COMMAND_KEY) return;
      const tabId = await getActiveTabId();
      if (typeof tabId !== 'number') return;
      await toggleEditorInTab(tabId);
    } catch {}
  });

  registerWebEditorMessageRouter();
}
