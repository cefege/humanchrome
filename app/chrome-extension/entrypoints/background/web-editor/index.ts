import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import {
  WEB_EDITOR_V2_ACTIONS,
  WEB_EDITOR_V1_ACTIONS,
  type ElementChangeSummary,
  type WebEditorApplyBatchPayload,
  type WebEditorTxChangedPayload,
  type WebEditorHighlightElementPayload,
  type WebEditorRevertElementPayload,
  type WebEditorCancelExecutionPayload,
  type WebEditorCancelExecutionResponse,
} from '@/common/web-editor-types';
import { openAgentChatSidepanel } from '../utils/sidepanel';
import {
  cancelSseConnectionForRequest,
  getExecutionStatus,
  setExecutionStatus,
  subscribeToSessionStatus,
} from './sse-client';
import { normalizeApplyBatchPayload, normalizeApplyPayload, normalizeString } from './normalizers';
import { buildAgentPrompt, buildAgentPromptBatch } from './prompt-builder';
import { registerPropsAgentEarlyInjection } from './early-injection';

const CONTEXT_MENU_ID = 'web_editor_toggle';
const COMMAND_KEY = 'toggle_web_editor';
const DEFAULT_NATIVE_SERVER_PORT = 12306;

/** Storage key prefix for TX change session data (per-tab isolation) */
const WEB_EDITOR_TX_CHANGED_SESSION_KEY_PREFIX = 'web-editor-v2-tx-changed-';
const WEB_EDITOR_SELECTION_SESSION_KEY_PREFIX = 'web-editor-v2-selection-';

/** Storage key prefix for excluded element keys (per-tab isolation, managed by sidepanel) */
const WEB_EDITOR_EXCLUDED_KEYS_SESSION_KEY_PREFIX = 'web-editor-v2-excluded-keys-';

/** Storage key for AgentChat selected session ID */
const STORAGE_KEY_SELECTED_SESSION = 'agent-selected-session-id';

/**
 * Web Editor version configuration
 * - v1: Legacy inject-scripts/web-editor.js (IIFE, ~850 lines)
 * - v2: New TypeScript-based web-editor-v2.js (WXT unlisted script)
 *
 * Set USE_WEB_EDITOR_V2 to true to enable v2.
 * This flag allows gradual rollout and easy rollback.
 */
const USE_WEB_EDITOR_V2 = true;

/** Script path for v1 (legacy) */
const V1_SCRIPT_PATH = 'inject-scripts/web-editor.js';

/** Script path for v2 (WXT unlisted script output) */
const V2_SCRIPT_PATH = 'web-editor-v2.js';

/** Script path for Phase 7 props agent (MAIN world) */
const PROPS_AGENT_SCRIPT_PATH = 'inject-scripts/props-agent.js';

async function ensureContextMenu(): Promise<void> {
  try {
    if (!(chrome as any).contextMenus?.create) return;
    try {
      await chrome.contextMenus.remove(CONTEXT_MENU_ID);
    } catch {}
    await chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Toggle web edit mode',
      contexts: ['all'],
    });
  } catch (error) {
    console.warn('[WebEditor] Failed to ensure context menu:', error);
  }
}

/**
 * Get the appropriate action constants based on version
 */
function getActions() {
  return USE_WEB_EDITOR_V2 ? WEB_EDITOR_V2_ACTIONS : WEB_EDITOR_V1_ACTIONS;
}

/**
 * Ensure the web editor script is injected into the tab
 * Supports both v1 (legacy) and v2 (new) versions
 *
 * V1 and V2 use different action names to avoid conflicts:
 * - V1: web_editor_ping, web_editor_toggle, etc.
 * - V2: web_editor_ping_v2, web_editor_toggle_v2, etc.
 */
async function ensureEditorInjected(tabId: number): Promise<void> {
  const scriptPath = USE_WEB_EDITOR_V2 ? V2_SCRIPT_PATH : V1_SCRIPT_PATH;
  const logPrefix = USE_WEB_EDITOR_V2 ? '[WebEditorV2]' : '[WebEditor]';
  const actions = getActions();

  // Try to ping existing instance using version-specific action
  try {
    const pong: { status?: string; version?: number } = await chrome.tabs.sendMessage(
      tabId,
      { action: actions.PING },
      { frameId: 0 },
    );

    if (pong?.status === 'pong') {
      // Already injected with correct version
      return;
    }
  } catch {
    // No existing instance, fallthrough to inject
  }

  // Inject the script
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [scriptPath],
      world: 'ISOLATED',
    });
    console.log(`${logPrefix} Script injected successfully`);
  } catch (error) {
    console.warn(`${logPrefix} Failed to inject editor script:`, error);
  }
}

/**
 * Inject props agent into MAIN world for Phase 7 Props editing
 * Only inject for v2 editor
 */
async function ensurePropsAgentInjected(tabId: number): Promise<void> {
  if (!USE_WEB_EDITOR_V2) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [PROPS_AGENT_SCRIPT_PATH],
      world: 'MAIN',
    });
  } catch (error) {
    // Best-effort: some pages (chrome://, extensions, PDF) block injection
    console.warn('[WebEditorV2] Failed to inject props agent:', error);
  }
}

/**
 * Send cleanup event to props agent
 */
async function sendPropsAgentCleanup(tabId: number): Promise<void> {
  if (!USE_WEB_EDITOR_V2) return;

  try {
    // Dispatch cleanup event in ISOLATED world
    // CustomEvent crosses worlds and is observed by MAIN agent
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          window.dispatchEvent(new CustomEvent('web-editor-props:cleanup'));
        } catch {
          // ignore
        }
      },
      world: 'ISOLATED',
    });
  } catch (error) {
    // Best-effort cleanup; ignore failures if tab is gone or injection blocked
    console.warn('[WebEditorV2] Failed to send props agent cleanup:', error);
  }
}

async function toggleEditorInTab(tabId: number): Promise<{ active?: boolean }> {
  await ensureEditorInjected(tabId);
  const logPrefix = USE_WEB_EDITOR_V2 ? '[WebEditorV2]' : '[WebEditor]';
  const actions = getActions();

  try {
    const resp: { active?: boolean } = await chrome.tabs.sendMessage(
      tabId,
      { action: actions.TOGGLE },
      { frameId: 0 },
    );
    const active = typeof resp?.active === 'boolean' ? resp.active : undefined;

    // Phase 7: Inject props agent on start; cleanup on stop
    if (active === true) {
      await ensurePropsAgentInjected(tabId);
    } else if (active === false) {
      await sendPropsAgentCleanup(tabId);
    }

    return { active };
  } catch (error) {
    console.warn(`${logPrefix} Failed to toggle editor in tab:`, error);
    return {};
  }
}

async function getActiveTabId(): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    return typeof tabId === 'number' ? tabId : null;
  } catch {
    return null;
  }
}

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

  if ((chrome as any).contextMenus?.onClicked?.addListener) {
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      // Phase 7.1.6: Handle early injection registration request
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_PROPS_REGISTER_EARLY_INJECTION) {
        (async () => {
          const senderTab = (_sender as chrome.runtime.MessageSender)?.tab;
          const senderTabId = senderTab?.id;
          const senderTabUrl = senderTab?.url;

          if (typeof senderTabId !== 'number' || typeof senderTabUrl !== 'string') {
            return sendResponse({
              success: false,
              error: 'Sender tab information is required',
            });
          }

          try {
            const result = await registerPropsAgentEarlyInjection(senderTabUrl);

            // Respond first, then reload (to avoid message port closing during navigation)
            sendResponse({ success: true, ...result });

            // Small delay to ensure response is sent before navigation
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Reload the tab so early injection takes effect
            try {
              await chrome.tabs.reload(senderTabId);
            } catch {
              // Best-effort: some tabs may block reload
            }
          } catch (err) {
            sendResponse({
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
        return true; // Async response
      }

      // =====================================================================
      // WEB_EDITOR_OPEN_SOURCE: Open component source file in VSCode
      // =====================================================================
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_OPEN_SOURCE) {
        (async () => {
          try {
            const payload = message.payload as { debugSource?: unknown } | undefined;
            const debugSource = payload?.debugSource;

            if (!debugSource || typeof debugSource !== 'object') {
              return sendResponse({ success: false, error: 'debugSource is required' });
            }

            const rec = debugSource as Record<string, unknown>;
            const file = typeof rec.file === 'string' ? rec.file.trim() : '';
            if (!file) {
              return sendResponse({ success: false, error: 'debugSource.file is required' });
            }

            // Read server port and selected project
            const stored = await chrome.storage.local.get([
              'nativeServerPort',
              'agent-selected-project-id',
            ]);
            const portRaw = stored.nativeServerPort;
            const port = Number.isFinite(Number(portRaw))
              ? Number(portRaw)
              : DEFAULT_NATIVE_SERVER_PORT;
            const projectId = stored['agent-selected-project-id'];

            if (!projectId || typeof projectId !== 'string') {
              return sendResponse({
                success: false,
                error: 'No project selected. Please select a project in AgentChat first.',
              });
            }

            // Prepare line/column
            const lineRaw = Number(rec.line);
            const columnRaw = Number(rec.column);
            const line = Number.isFinite(lineRaw) && lineRaw > 0 ? lineRaw : undefined;
            const column = Number.isFinite(columnRaw) && columnRaw > 0 ? columnRaw : undefined;

            // Call native-server to open file (server will validate project and path)
            const openResp = await fetch(
              `http://127.0.0.1:${port}/agent/projects/${encodeURIComponent(projectId)}/open-file`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  filePath: file,
                  line,
                  column,
                }),
              },
            );

            // Try to parse JSON response for detailed error
            let result: { success: boolean; error?: string };
            try {
              result = await openResp.json();
            } catch {
              const text = await openResp.text().catch(() => '');
              result = {
                success: false,
                error: text || `HTTP ${openResp.status}`,
              };
            }

            sendResponse(result);
          } catch (err) {
            sendResponse({
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
        return true; // Async response
      }

      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TOGGLE) {
        getActiveTabId()
          .then(async (tabId) => {
            if (typeof tabId !== 'number') return sendResponse({ success: false });
            const result = await toggleEditorInTab(tabId);
            sendResponse({ success: true, ...result });
          })
          .catch(() => sendResponse({ success: false }));
        return true;
      }

      // =======================================================================
      // Phase 1.5: Handle TX_CHANGED broadcast from web-editor
      // =======================================================================
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED) {
        (async () => {
          const senderTabId = (_sender as chrome.runtime.MessageSender)?.tab?.id;
          if (typeof senderTabId !== 'number') {
            sendResponse({ success: false, error: 'Sender tabId is required' });
            return;
          }

          const rawPayload = message.payload as WebEditorTxChangedPayload | undefined;
          if (!rawPayload || typeof rawPayload !== 'object') {
            sendResponse({ success: false, error: 'Invalid payload' });
            return;
          }

          // Hydrate payload with tabId from sender
          const payload: WebEditorTxChangedPayload = { ...rawPayload, tabId: senderTabId };
          const storageKey = `${WEB_EDITOR_TX_CHANGED_SESSION_KEY_PREFIX}${senderTabId}`;

          // Persist to session storage for cold-start recovery
          // Remove keys on clear to avoid stale data (rollback still has edits, so keep it)
          if (payload.action === 'clear') {
            // Clear TX state and excluded keys together
            const excludedKey = `${WEB_EDITOR_EXCLUDED_KEYS_SESSION_KEY_PREFIX}${senderTabId}`;
            await chrome.storage.session.remove([storageKey, excludedKey]);
          } else {
            await chrome.storage.session.set({ [storageKey]: payload });
          }

          // Broadcast to sidepanel (best-effort, ignore errors if sidepanel is closed)
          chrome.runtime
            .sendMessage({
              type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED,
              payload,
            })
            .catch(() => {
              // Ignore errors - sidepanel may be closed
            });

          sendResponse({ success: true });
        })().catch((error) => {
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          });
        });
        return true;
      }

      // =======================================================================
      // Selection sync: Handle SELECTION_CHANGED broadcast from web-editor
      // =======================================================================
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_SELECTION_CHANGED) {
        (async () => {
          const senderTabId = (_sender as chrome.runtime.MessageSender)?.tab?.id;
          if (typeof senderTabId !== 'number') {
            sendResponse({ success: false, error: 'Sender tabId is required' });
            return;
          }

          const rawPayload = message.payload as
            | import('@/common/web-editor-types').WebEditorSelectionChangedPayload
            | undefined;
          if (!rawPayload || typeof rawPayload !== 'object') {
            sendResponse({ success: false, error: 'Invalid payload' });
            return;
          }

          // Hydrate payload with tabId from sender
          const payload = { ...rawPayload, tabId: senderTabId };
          const storageKey = `${WEB_EDITOR_SELECTION_SESSION_KEY_PREFIX}${senderTabId}`;

          // Persist to session storage for cold-start recovery
          // Remove key on deselection to avoid stale data
          if (payload.selected === null) {
            await chrome.storage.session.remove(storageKey);
          } else {
            await chrome.storage.session.set({ [storageKey]: payload });
          }

          // Broadcast to sidepanel (best-effort, ignore errors if sidepanel is closed)
          chrome.runtime
            .sendMessage({
              type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_SELECTION_CHANGED,
              payload,
            })
            .catch(() => {
              // Ignore errors - sidepanel may be closed
            });

          sendResponse({ success: true });
        })().catch((error) => {
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          });
        });
        return true;
      }

      // =======================================================================
      // Clear selection: Handle CLEAR_SELECTION from sidepanel (after send)
      // =======================================================================
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_CLEAR_SELECTION) {
        (async () => {
          const payload = message.payload as { tabId?: number } | undefined;
          const targetTabId = payload?.tabId;

          if (typeof targetTabId !== 'number' || targetTabId <= 0) {
            sendResponse({ success: false, error: 'Invalid tabId' });
            return;
          }

          // Forward to content script (web-editor-v2)
          try {
            await chrome.tabs.sendMessage(targetTabId, {
              action: WEB_EDITOR_V2_ACTIONS.CLEAR_SELECTION,
            });
            sendResponse({ success: true });
          } catch (error) {
            // Tab may be closed or web-editor not active - this is expected
            sendResponse({
              success: false,
              error: error instanceof Error ? error.message : 'Failed to send to tab',
            });
          }
        })().catch((error) => {
          // Catch any unhandled errors in the async IIFE
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          });
        });
        return true;
      }

      // =======================================================================
      // Phase 1.5: Handle APPLY_BATCH from web-editor toolbar
      // =======================================================================
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_APPLY_BATCH) {
        const payload = normalizeApplyBatchPayload(message.payload);
        (async () => {
          const senderTabId = (_sender as chrome.runtime.MessageSender)?.tab?.id;
          const senderWindowId = (_sender as chrome.runtime.MessageSender)?.tab?.windowId;

          // Read storage for server port and selected session
          const stored = await chrome.storage.local.get([
            'nativeServerPort',
            STORAGE_KEY_SELECTED_SESSION,
          ]);

          const portRaw = stored?.nativeServerPort;
          const port = Number.isFinite(Number(portRaw))
            ? Number(portRaw)
            : DEFAULT_NATIVE_SERVER_PORT;

          const sessionId = normalizeString(stored?.[STORAGE_KEY_SELECTED_SESSION]).trim();

          // Best-effort: open AgentChat sidepanel so user can see the session
          // Pass sessionId for deep linking directly to chat view
          if (typeof senderTabId === 'number') {
            openAgentChatSidepanel(senderTabId, senderWindowId, sessionId || undefined).catch(
              () => {},
            );
          }

          if (!sessionId) {
            // No session selected - sidepanel is already being opened (best-effort)
            // User needs to select or create a session manually
            sendResponse({
              success: false,
              error:
                'No Agent session selected. Please select or create a session in AgentChat, then try Apply again.',
            });
            return;
          }

          // Hydrate payload with tabId
          const hydratedPayload: WebEditorApplyBatchPayload =
            typeof senderTabId === 'number' ? { ...payload, tabId: senderTabId } : payload;

          // Read excluded keys from session storage (per-tab, managed by sidepanel)
          let sessionExcludedKeys: string[] = [];
          if (typeof senderTabId === 'number') {
            const excludedSessionKey = `${WEB_EDITOR_EXCLUDED_KEYS_SESSION_KEY_PREFIX}${senderTabId}`;
            try {
              if (chrome.storage?.session?.get) {
                const stored = (await chrome.storage.session.get(excludedSessionKey)) as Record<
                  string,
                  unknown
                >;
                const raw = stored?.[excludedSessionKey];
                sessionExcludedKeys = Array.isArray(raw)
                  ? raw.map((k) => normalizeString(k).trim()).filter(Boolean)
                  : [];
              }
            } catch {
              // Best-effort: ignore session storage failures
            }
          }

          // Filter out excluded elements (union: payload excludedKeys + session excludedKeys)
          const excluded = new Set([...hydratedPayload.excludedKeys, ...sessionExcludedKeys]);
          const elements = hydratedPayload.elements.filter((e) => !excluded.has(e.elementKey));
          if (elements.length === 0) {
            sendResponse({ success: false, error: 'No elements selected to apply.' });
            return;
          }

          // Build page URL from payload or sender tab
          const pageUrl =
            normalizeString(hydratedPayload.pageUrl).trim() ||
            normalizeString((_sender as chrome.runtime.MessageSender)?.tab?.url).trim() ||
            'unknown';

          // Build batch prompt and send to agent
          const instruction = buildAgentPromptBatch(elements, pageUrl);
          const url = `http://127.0.0.1:${port}/agent/chat/${encodeURIComponent(sessionId)}/act`;

          // Extract element labels for compact display
          const elementLabels = elements.slice(0, 5).map((e) => e.label);

          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              instruction,
              // Pass dbSessionId so backend loads session-level configuration (engine, model, options)
              dbSessionId: sessionId,
              // Display text for UI (compact representation)
              displayText: `Apply ${elements.length} change${elements.length === 1 ? '' : 's'}`,
              // Client metadata for special message rendering
              clientMeta: {
                kind: 'web_editor_apply_batch',
                pageUrl,
                elementCount: elements.length,
                elementLabels,
              },
            }),
          });

          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            sendResponse({
              success: false,
              error: text || `HTTP ${resp.status}`,
            });
            return;
          }

          const json: any = await resp.json().catch(() => ({}));
          const requestId = json?.requestId as string | undefined;

          if (requestId) {
            // Start SSE subscription for status updates (fire and forget)
            subscribeToSessionStatus(sessionId, requestId, port).catch(() => {});
          }

          sendResponse({ success: true, requestId, sessionId });
        })().catch((error) => {
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          });
        });
        return true;
      }

      // =======================================================================
      // Phase 1.8: Handle HIGHLIGHT_ELEMENT from sidepanel chips hover
      // =======================================================================
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_HIGHLIGHT_ELEMENT) {
        const payload = message.payload as WebEditorHighlightElementPayload | undefined;
        (async () => {
          // Validate payload
          const tabId = payload?.tabId;
          if (typeof tabId !== 'number' || !Number.isFinite(tabId) || tabId <= 0) {
            sendResponse({ success: false, error: 'Invalid tabId' });
            return;
          }

          const mode = payload?.mode;
          if (mode !== 'hover' && mode !== 'clear') {
            sendResponse({ success: false, error: 'Invalid mode' });
            return;
          }

          // Clear mode: forward directly without locator/selector validation
          // This prevents overlay residue when sidepanel unmounts
          if (mode === 'clear') {
            try {
              const response = await chrome.tabs.sendMessage(tabId, {
                action: WEB_EDITOR_V2_ACTIONS.HIGHLIGHT_ELEMENT,
                mode: 'clear',
              });
              sendResponse({ success: true, response });
            } catch (error) {
              sendResponse({
                success: false,
                error: String(error instanceof Error ? error.message : error),
              });
            }
            return;
          }

          // Hover mode: validate and forward locator
          const locator = payload?.locator;
          if (!locator || typeof locator !== 'object') {
            sendResponse({ success: false, error: 'Invalid locator' });
            return;
          }

          // Extract best selector for fallback highlighting
          const selectors = Array.isArray(locator.selectors) ? locator.selectors : [];
          const primarySelector = selectors.find(
            (s): s is string => typeof s === 'string' && s.trim().length > 0,
          );

          if (!primarySelector) {
            sendResponse({ success: false, error: 'No valid selector in locator' });
            return;
          }

          // Forward to web-editor content script
          try {
            const response = await chrome.tabs.sendMessage(tabId, {
              action: WEB_EDITOR_V2_ACTIONS.HIGHLIGHT_ELEMENT,
              locator, // Full locator for Shadow DOM/iframe support
              selector: primarySelector, // Backward compatibility fallback
              mode,
              elementKey: payload.elementKey,
            });

            sendResponse({ success: true, response });
          } catch (error) {
            // Content script might not be available
            sendResponse({
              success: false,
              error: String(error instanceof Error ? error.message : error),
            });
          }
        })().catch((error) => {
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          });
        });
        return true;
      }

      // =======================================================================
      // Phase 2: Handle REVERT_ELEMENT from sidepanel chips
      // =======================================================================
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_REVERT_ELEMENT) {
        const payload = message.payload as WebEditorRevertElementPayload | undefined;
        (async () => {
          // Validate payload
          const tabId = payload?.tabId;
          if (typeof tabId !== 'number' || !Number.isFinite(tabId) || tabId <= 0) {
            sendResponse({ success: false, error: 'Invalid tabId' });
            return;
          }

          const elementKey = payload?.elementKey;
          if (typeof elementKey !== 'string' || !elementKey.trim()) {
            sendResponse({ success: false, error: 'Invalid elementKey' });
            return;
          }

          // Forward to web-editor content script (frameId: 0 for main frame only)
          try {
            const response = await chrome.tabs.sendMessage(
              tabId,
              {
                action: WEB_EDITOR_V2_ACTIONS.REVERT_ELEMENT,
                elementKey,
              },
              { frameId: 0 },
            );

            sendResponse({ success: true, ...response });
          } catch (error) {
            // Content script might not be available
            sendResponse({
              success: false,
              error: String(error instanceof Error ? error.message : error),
            });
          }
        })().catch((error) => {
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          });
        });
        return true;
      }

      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_APPLY) {
        const payload = normalizeApplyPayload(message.payload);
        (async () => {
          const senderTabId = (_sender as any)?.tab?.id;
          const sessionId =
            typeof senderTabId === 'number' ? `web-editor-${senderTabId}` : 'web-editor';

          const stored = await chrome.storage.local.get([
            'nativeServerPort',
            'agent-selected-project-id',
          ]);
          const portRaw = stored?.nativeServerPort;
          const port = Number.isFinite(Number(portRaw))
            ? Number(portRaw)
            : DEFAULT_NATIVE_SERVER_PORT;

          const projectId = normalizeString(stored?.['agent-selected-project-id']).trim() || '';

          if (!projectId) {
            return sendResponse({
              success: false,
              error:
                'No Agent project selected. Open Side Panel → Agent Chat and select/create a project first.',
            });
          }

          const instruction = buildAgentPrompt(payload);
          const url = `http://127.0.0.1:${port}/agent/chat/${encodeURIComponent(sessionId)}/act`;

          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              instruction,
              projectId,
            }),
          });

          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            return sendResponse({
              success: false,
              error: text || `HTTP ${resp.status}`,
            });
          }

          const json: any = await resp.json().catch(() => ({}));
          const requestId = json?.requestId as string | undefined;

          if (requestId) {
            // Start SSE subscription for status updates (fire and forget)
            subscribeToSessionStatus(sessionId, requestId, port).catch(() => {});
          }

          return sendResponse({ success: true, requestId, sessionId });
        })().catch((error) => {
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          });
        });
        return true;
      }
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_STATUS_QUERY) {
        const { requestId } = message;
        if (!requestId || typeof requestId !== 'string') {
          sendResponse({ success: false, error: 'requestId is required' });
          return false;
        }

        const entry = getExecutionStatus(requestId);
        if (!entry) {
          // No status yet - likely still pending or not tracked
          sendResponse({ success: true, status: 'pending', message: 'Waiting for status...' });
        } else {
          sendResponse({
            success: true,
            status: entry.status,
            message: entry.message,
            result: entry.result,
          });
        }
        return false; // Synchronous response
      }

      // =======================================================================
      // Cancel Execution: Handle WEB_EDITOR_CANCEL_EXECUTION from toolbar/sidepanel
      // =======================================================================
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_CANCEL_EXECUTION) {
        const payload = message.payload as WebEditorCancelExecutionPayload | undefined;
        (async () => {
          // Validate payload
          const sessionId = payload?.sessionId?.trim();
          const requestId = payload?.requestId?.trim();

          if (!sessionId) {
            sendResponse({
              success: false,
              error: 'sessionId is required',
            } as WebEditorCancelExecutionResponse);
            return;
          }
          if (!requestId) {
            sendResponse({
              success: false,
              error: 'requestId is required',
            } as WebEditorCancelExecutionResponse);
            return;
          }

          // Get server port
          const stored = await chrome.storage.local.get(['nativeServerPort']);
          const port = stored.nativeServerPort || DEFAULT_NATIVE_SERVER_PORT;

          try {
            // Call cancel API
            const cancelUrl = `http://127.0.0.1:${port}/agent/chat/${encodeURIComponent(sessionId)}/cancel/${encodeURIComponent(requestId)}`;
            const response = await fetch(cancelUrl, { method: 'DELETE' });

            if (!response.ok) {
              const errorText = await response.text().catch(() => `HTTP ${response.status}`);
              sendResponse({
                success: false,
                error: errorText,
              } as WebEditorCancelExecutionResponse);
              return;
            }

            // Update local execution status cache
            setExecutionStatus(requestId, 'cancelled', 'Execution cancelled by user');

            // Abort SSE connection for this session (only if it's still
            // tied to the request being cancelled — newer requests on the
            // same session must not be torn down by a stale cancel).
            cancelSseConnectionForRequest(sessionId, requestId);

            sendResponse({ success: true } as WebEditorCancelExecutionResponse);
          } catch (error) {
            sendResponse({
              success: false,
              error: String(error instanceof Error ? error.message : error),
            } as WebEditorCancelExecutionResponse);
          }
        })().catch((error) => {
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          } as WebEditorCancelExecutionResponse);
        });
        return true; // Will respond asynchronously
      }
    } catch (error) {
      sendResponse({
        success: false,
        error: String(error instanceof Error ? error.message : error),
      });
    }
    return false;
  });
}
