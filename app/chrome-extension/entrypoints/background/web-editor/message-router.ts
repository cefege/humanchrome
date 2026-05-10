/**
 * Web-editor chrome.runtime.onMessage handler (IMP-0034).
 *
 * Lifted out of web-editor/index.ts so the orchestrator stays a thin
 * lifecycle hook. This module owns the ~700-line dispatch over every
 * BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_* message: TX/selection sync,
 * apply/apply-batch, highlight/revert, status query, cancel, open-source,
 * toggle, early-injection registration.
 *
 * Storage-key constants and the DEFAULT_NATIVE_SERVER_PORT live with the
 * router because the index module no longer references them.
 */
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import {
  WEB_EDITOR_V2_ACTIONS,
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
import { getActiveTabId, toggleEditorInTab } from './editor-lifecycle';

const DEFAULT_NATIVE_SERVER_PORT = 12306;

const WEB_EDITOR_TX_CHANGED_SESSION_KEY_PREFIX = 'web-editor-v2-tx-changed-';
const WEB_EDITOR_SELECTION_SESSION_KEY_PREFIX = 'web-editor-v2-selection-';
const WEB_EDITOR_EXCLUDED_KEYS_SESSION_KEY_PREFIX = 'web-editor-v2-excluded-keys-';
const STORAGE_KEY_SELECTED_SESSION = 'agent-selected-session-id';

export function registerWebEditorMessageRouter(): void {
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

            // Respond first, then reload (avoids message-port closure during navigation)
            sendResponse({ success: true, ...result });

            // Small delay to ensure response is sent before navigation
            await new Promise((resolve) => setTimeout(resolve, 50));

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
        return true;
      }

      // WEB_EDITOR_OPEN_SOURCE: Open component source file in VSCode
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

            const lineRaw = Number(rec.line);
            const columnRaw = Number(rec.column);
            const line = Number.isFinite(lineRaw) && lineRaw > 0 ? lineRaw : undefined;
            const column = Number.isFinite(columnRaw) && columnRaw > 0 ? columnRaw : undefined;

            const openResp = await fetch(
              `http://127.0.0.1:${port}/agent/projects/${encodeURIComponent(projectId)}/open-file`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filePath: file, line, column }),
              },
            );

            let result: { success: boolean; error?: string };
            try {
              result = await openResp.json();
            } catch {
              const text = await openResp.text().catch(() => '');
              result = { success: false, error: text || `HTTP ${openResp.status}` };
            }

            sendResponse(result);
          } catch (err) {
            sendResponse({
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
        return true;
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

      // Phase 1.5: Handle TX_CHANGED broadcast from web-editor
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

          const payload: WebEditorTxChangedPayload = { ...rawPayload, tabId: senderTabId };
          const storageKey = `${WEB_EDITOR_TX_CHANGED_SESSION_KEY_PREFIX}${senderTabId}`;

          // Persist to session storage for cold-start recovery
          // Remove keys on clear to avoid stale data (rollback still has edits, so keep it)
          if (payload.action === 'clear') {
            const excludedKey = `${WEB_EDITOR_EXCLUDED_KEYS_SESSION_KEY_PREFIX}${senderTabId}`;
            await chrome.storage.session.remove([storageKey, excludedKey]);
          } else {
            await chrome.storage.session.set({ [storageKey]: payload });
          }

          // Broadcast to sidepanel (best-effort, ignore errors if sidepanel is closed)
          chrome.runtime
            .sendMessage({ type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED, payload })
            .catch(() => {});

          sendResponse({ success: true });
        })().catch((error) => {
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          });
        });
        return true;
      }

      // Selection sync: Handle SELECTION_CHANGED broadcast from web-editor
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

          const payload = { ...rawPayload, tabId: senderTabId };
          const storageKey = `${WEB_EDITOR_SELECTION_SESSION_KEY_PREFIX}${senderTabId}`;

          if (payload.selected === null) {
            await chrome.storage.session.remove(storageKey);
          } else {
            await chrome.storage.session.set({ [storageKey]: payload });
          }

          chrome.runtime
            .sendMessage({
              type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_SELECTION_CHANGED,
              payload,
            })
            .catch(() => {});

          sendResponse({ success: true });
        })().catch((error) => {
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          });
        });
        return true;
      }

      // Clear selection: Handle CLEAR_SELECTION from sidepanel (after send)
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_CLEAR_SELECTION) {
        (async () => {
          const payload = message.payload as { tabId?: number } | undefined;
          const targetTabId = payload?.tabId;

          if (typeof targetTabId !== 'number' || targetTabId <= 0) {
            sendResponse({ success: false, error: 'Invalid tabId' });
            return;
          }

          try {
            await chrome.tabs.sendMessage(targetTabId, {
              action: WEB_EDITOR_V2_ACTIONS.CLEAR_SELECTION,
            });
            sendResponse({ success: true });
          } catch (error) {
            sendResponse({
              success: false,
              error: error instanceof Error ? error.message : 'Failed to send to tab',
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

      // Phase 1.5: Handle APPLY_BATCH from web-editor toolbar
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_APPLY_BATCH) {
        const payload = normalizeApplyBatchPayload(message.payload);
        (async () => {
          const senderTabId = (_sender as chrome.runtime.MessageSender)?.tab?.id;
          const senderWindowId = (_sender as chrome.runtime.MessageSender)?.tab?.windowId;

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
          if (typeof senderTabId === 'number') {
            openAgentChatSidepanel(senderTabId, senderWindowId, sessionId || undefined).catch(
              () => {},
            );
          }

          if (!sessionId) {
            sendResponse({
              success: false,
              error:
                'No Agent session selected. Please select or create a session in AgentChat, then try Apply again.',
            });
            return;
          }

          const hydratedPayload: WebEditorApplyBatchPayload =
            typeof senderTabId === 'number' ? { ...payload, tabId: senderTabId } : payload;

          // Read excluded keys from session storage (per-tab, managed by sidepanel)
          let sessionExcludedKeys: string[] = [];
          if (typeof senderTabId === 'number') {
            const excludedSessionKey = `${WEB_EDITOR_EXCLUDED_KEYS_SESSION_KEY_PREFIX}${senderTabId}`;
            try {
              if (chrome.storage?.session?.get) {
                const sessionStored = (await chrome.storage.session.get(
                  excludedSessionKey,
                )) as Record<string, unknown>;
                const raw = sessionStored?.[excludedSessionKey];
                sessionExcludedKeys = Array.isArray(raw)
                  ? raw.map((k) => normalizeString(k).trim()).filter(Boolean)
                  : [];
              }
            } catch {
              // Best-effort
            }
          }

          const excluded = new Set([...hydratedPayload.excludedKeys, ...sessionExcludedKeys]);
          const elements = hydratedPayload.elements.filter((e) => !excluded.has(e.elementKey));
          if (elements.length === 0) {
            sendResponse({ success: false, error: 'No elements selected to apply.' });
            return;
          }

          const pageUrl =
            normalizeString(hydratedPayload.pageUrl).trim() ||
            normalizeString((_sender as chrome.runtime.MessageSender)?.tab?.url).trim() ||
            'unknown';

          const instruction = buildAgentPromptBatch(elements, pageUrl);
          const url = `http://127.0.0.1:${port}/agent/chat/${encodeURIComponent(sessionId)}/act`;

          const elementLabels = elements.slice(0, 5).map((e) => e.label);

          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              instruction,
              dbSessionId: sessionId,
              displayText: `Apply ${elements.length} change${elements.length === 1 ? '' : 's'}`,
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
            sendResponse({ success: false, error: text || `HTTP ${resp.status}` });
            return;
          }

          const json = (await resp.json().catch(() => ({}))) as { requestId?: string };
          const requestId = json?.requestId;

          if (requestId) {
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

      // Phase 1.8: Handle HIGHLIGHT_ELEMENT from sidepanel chips hover
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_HIGHLIGHT_ELEMENT) {
        const payload = message.payload as WebEditorHighlightElementPayload | undefined;
        (async () => {
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

          // Clear mode: forward directly without locator/selector validation.
          // This prevents overlay residue when sidepanel unmounts.
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

          const locator = payload?.locator;
          if (!locator || typeof locator !== 'object') {
            sendResponse({ success: false, error: 'Invalid locator' });
            return;
          }

          const selectors = Array.isArray(locator.selectors) ? locator.selectors : [];
          const primarySelector = selectors.find(
            (s): s is string => typeof s === 'string' && s.trim().length > 0,
          );

          if (!primarySelector) {
            sendResponse({ success: false, error: 'No valid selector in locator' });
            return;
          }

          try {
            const response = await chrome.tabs.sendMessage(tabId, {
              action: WEB_EDITOR_V2_ACTIONS.HIGHLIGHT_ELEMENT,
              locator,
              selector: primarySelector,
              mode,
              elementKey: payload.elementKey,
            });

            sendResponse({ success: true, response });
          } catch (error) {
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

      // Phase 2: Handle REVERT_ELEMENT from sidepanel chips
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_REVERT_ELEMENT) {
        const payload = message.payload as WebEditorRevertElementPayload | undefined;
        (async () => {
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

          try {
            const response = await chrome.tabs.sendMessage(
              tabId,
              { action: WEB_EDITOR_V2_ACTIONS.REVERT_ELEMENT, elementKey },
              { frameId: 0 },
            );

            sendResponse({ success: true, ...response });
          } catch (error) {
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
          const senderTabId = (_sender as chrome.runtime.MessageSender)?.tab?.id;
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
            body: JSON.stringify({ instruction, projectId }),
          });

          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            return sendResponse({
              success: false,
              error: text || `HTTP ${resp.status}`,
            });
          }

          const json = (await resp.json().catch(() => ({}))) as { requestId?: string };
          const requestId = json?.requestId;

          if (requestId) {
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
          sendResponse({ success: true, status: 'pending', message: 'Waiting for status...' });
        } else {
          sendResponse({
            success: true,
            status: entry.status,
            message: entry.message,
            result: entry.result,
          });
        }
        return false;
      }

      // Cancel Execution: Handle WEB_EDITOR_CANCEL_EXECUTION from toolbar/sidepanel
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_CANCEL_EXECUTION) {
        const payload = message.payload as WebEditorCancelExecutionPayload | undefined;
        (async () => {
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

          const stored = await chrome.storage.local.get(['nativeServerPort']);
          const port = stored.nativeServerPort || DEFAULT_NATIVE_SERVER_PORT;

          try {
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

            setExecutionStatus(requestId, 'cancelled', 'Execution cancelled by user');

            // Abort SSE connection for this session — only if still tied to
            // the request being cancelled. Newer requests on the same session
            // must not be torn down by a stale cancel.
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
        return true;
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
