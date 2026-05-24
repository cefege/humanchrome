/**
 * Web Editor V2 — AgentChat broadcast layer (Phase 1.4).
 *
 * Owns the messaging surface between the editor and the extension UI
 * (e.g., the Sidepanel): transaction-state changes, selection changes,
 * and the "editor cleared" notification on stop.
 *
 * Module state owned here:
 *   - debounced TX-changed timer + pending action
 *   - last-broadcasted selection key (for dedupe)
 */

import type {
  SelectedElementSummary,
  WebEditorSelectionChangedPayload,
  WebEditorTxChangeAction,
  WebEditorTxChangedPayload,
} from '@/common/web-editor-types';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { aggregateTransactionsByElement } from '../transaction-aggregator';
import {
  generateElementLabel,
  generateFullElementLabel,
  generateStableElementKey,
} from '../element-key';
import { createElementLocator } from '../locator';
import type { Broadcaster, EditorInternalState } from './types';

const TX_CHANGED_BROADCAST_DEBOUNCE_MS = 100;

export interface BroadcasterDeps {
  state: EditorInternalState;
}

export function createBroadcaster({ state }: BroadcasterDeps): Broadcaster {
  let txChangedBroadcastTimer: number | null = null;
  let pendingTxAction: WebEditorTxChangeAction = 'push';
  let lastBroadcastedSelectionKey: string | null = null;

  /**
   * Broadcast aggregated transaction state to extension UI (e.g., Sidepanel).
   *
   * Runs on a short debounce because TransactionManager can emit frequent
   * merge events during continuous interactions (e.g., dragging sliders).
   *
   * NOTE: tabId is set to 0 here; background script fills the actual tabId
   * from sender.tab.id and updates storage with per-tab keys.
   */
  function broadcastTxChanged(action: WebEditorTxChangeAction): void {
    // Track the action for when debounce fires
    pendingTxAction = action;

    // For 'clear', broadcast immediately so UI updates instantly on apply
    const shouldBroadcastImmediately = action === 'clear';

    if (txChangedBroadcastTimer !== null) {
      window.clearTimeout(txChangedBroadcastTimer);
      txChangedBroadcastTimer = null;
    }

    const doBroadcast = (): void => {
      const tm = state.transactionManager;
      if (!tm) return;

      const undoStack = tm.getUndoStack();
      const redoStack = tm.getRedoStack();
      const elements = aggregateTransactionsByElement(undoStack);

      const payload: WebEditorTxChangedPayload = {
        tabId: 0, // Filled by background script from sender.tab.id
        action: pendingTxAction,
        elements,
        undoCount: undoStack.length,
        redoCount: redoStack.length,
        hasApplicableChanges: elements.length > 0,
        pageUrl: window.location.href,
      };

      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime
          .sendMessage({
            type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED,
            payload,
          })
          .catch(() => {
            // Ignore if no listeners (e.g., sidepanel not open)
          });
      }
    };

    if (shouldBroadcastImmediately) {
      doBroadcast();
    } else {
      txChangedBroadcastTimer = window.setTimeout(doBroadcast, TX_CHANGED_BROADCAST_DEBOUNCE_MS);
    }
  }

  /**
   * Broadcast selection change to sidepanel (no debounce — immediate).
   * Called when user selects or deselects an element.
   */
  function broadcastSelectionChanged(element: Element | null): void {
    let selected: SelectedElementSummary | null = null;

    if (element) {
      const elementKey = generateStableElementKey(element);

      // Dedupe: skip if same element already broadcasted
      if (elementKey === lastBroadcastedSelectionKey) return;
      lastBroadcastedSelectionKey = elementKey;

      const locator = createElementLocator(element);
      selected = {
        elementKey,
        locator,
        label: generateElementLabel(element),
        fullLabel: generateFullElementLabel(element),
        tagName: element.tagName.toLowerCase(),
        updatedAt: Date.now(),
      };
    } else {
      // Deselection — clear tracking
      if (lastBroadcastedSelectionKey === null) return; // Already deselected
      lastBroadcastedSelectionKey = null;
    }

    const payload: WebEditorSelectionChangedPayload = {
      tabId: 0,
      selected,
      pageUrl: window.location.href,
    };

    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime
        .sendMessage({
          type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_SELECTION_CHANGED,
          payload,
        })
        .catch(() => {
          // Ignore if no listeners (e.g., sidepanel not open)
        });
    }
  }

  /**
   * Broadcast "editor cleared" state when stopping.
   * Sends empty TX and null selection to remove chips from sidepanel.
   */
  function broadcastEditorCleared(): void {
    // Reset selection dedupe so next start can broadcast correctly
    lastBroadcastedSelectionKey = null;

    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;

    const pageUrl = window.location.href;

    const txPayload: WebEditorTxChangedPayload = {
      tabId: 0,
      action: 'clear',
      elements: [],
      undoCount: 0,
      redoCount: 0,
      hasApplicableChanges: false,
      pageUrl,
    };

    const selectionPayload: WebEditorSelectionChangedPayload = {
      tabId: 0,
      selected: null,
      pageUrl,
    };

    chrome.runtime
      .sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED,
        payload: txPayload,
      })
      .catch(() => {});

    chrome.runtime
      .sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_SELECTION_CHANGED,
        payload: selectionPayload,
      })
      .catch(() => {});
  }

  function cancelPending(): void {
    if (txChangedBroadcastTimer !== null) {
      window.clearTimeout(txChangedBroadcastTimer);
      txChangedBroadcastTimer = null;
    }
  }

  return {
    broadcastTxChanged,
    broadcastSelectionChanged,
    broadcastEditorCleared,
    cancelPending,
  };
}
