/**
 * Web Editor V2 — Apply-to-Code path.
 *
 * Owns the "Apply" pipeline that ships editor transactions to the Agent:
 *   - applyLatestTransaction (single, with auto-rollback on failure)
 *   - applyAllTransactions   (batch, no auto-rollback)
 *   - revertElement          (selective revert with compensating tx)
 *
 * The orchestrator owns selection state and provides deselect to clear UI
 * after a successful batch apply.
 */

import type {
  WebEditorApplyBatchPayload,
  WebEditorElementKey,
  WebEditorRevertElementResponse,
} from '@/common/web-editor-types';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { WEB_EDITOR_V2_LOG_PREFIX } from '../../constants';
import { locateElement } from '../locator';
import { sendTransactionToAgent } from '../payload-builder';
import { aggregateTransactionsByElement } from '../transaction-aggregator';
import type { EditorInternalState, TransactionApplyController } from './types';

export interface TransactionApplyDeps {
  state: EditorInternalState;
  /** Orchestrator deselect (clears UI after successful batch apply). */
  onDeselect(): void;
}

/**
 * Detailed status used to decide whether to auto-rollback on failure.
 * 'ok'             — transaction is still latest, safe to rollback
 * 'no_snapshot'    — no apply in progress
 * 'tm_unavailable' — TransactionManager not available
 * 'stack_empty'    — undo stack is empty (tx was already undone)
 * 'tx_changed'     — user made new edits or tx was merged
 */
type ApplyTxStatus = 'ok' | 'no_snapshot' | 'tm_unavailable' | 'stack_empty' | 'tx_changed';

export function createTransactionApply({
  state,
  onDeselect,
}: TransactionApplyDeps): TransactionApplyController {
  function checkApplyingTxStatus(): ApplyTxStatus {
    const snapshot = state.applyingSnapshot;
    if (!snapshot) return 'no_snapshot';

    const tm = state.transactionManager;
    if (!tm) return 'tm_unavailable';

    const undoStack = tm.getUndoStack();
    if (undoStack.length === 0) return 'stack_empty';

    const latest = undoStack[undoStack.length - 1]!;

    // Check both id and timestamp to handle merged transactions
    if (latest.id !== snapshot.txId || latest.timestamp !== snapshot.txTimestamp) {
      return 'tx_changed';
    }

    return 'ok';
  }

  /**
   * Attempt to rollback the applying transaction on failure.
   * Returns a descriptive error message based on rollback result.
   */
  function attemptRollbackOnFailure(originalError: string): string {
    const status = checkApplyingTxStatus();

    if (status === 'no_snapshot' || status === 'tm_unavailable') {
      console.error(`${WEB_EDITOR_V2_LOG_PREFIX} Apply failed, unable to revert (${status})`);
      return `${originalError} (unable to revert)`;
    }

    if (status === 'stack_empty') {
      console.warn(`${WEB_EDITOR_V2_LOG_PREFIX} Apply failed, stack empty (already reverted?)`);
      return `${originalError} (already reverted)`;
    }

    if (status === 'tx_changed') {
      console.warn(
        `${WEB_EDITOR_V2_LOG_PREFIX} Apply failed but new edits detected, skipping auto-rollback`,
      );
      return `${originalError} (new edits detected, not reverted)`;
    }

    // Status is 'ok' — safe to attempt rollback
    const tm = state.transactionManager!;
    const undone = tm.undo();
    if (undone) {
      console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Apply failed, changes auto-reverted`);
      return `${originalError} (changes reverted)`;
    }

    console.error(`${WEB_EDITOR_V2_LOG_PREFIX} Apply failed and auto-revert also failed`);
    return `${originalError} (revert failed)`;
  }

  /**
   * Apply the latest transaction to Agent (Apply to Code).
   *
   * Phase 2.10: On failure, automatically attempts to undo the transaction
   * to revert DOM changes. The transaction moves to redo stack so user can retry.
   */
  async function applyLatestTransaction(): Promise<{ requestId?: string; sessionId?: string }> {
    const tm = state.transactionManager;
    if (!tm) {
      throw new Error('Transaction manager not ready');
    }

    if (state.applyingSnapshot) {
      throw new Error('Apply already in progress');
    }

    const undoStack = tm.getUndoStack();
    const tx = undoStack.length > 0 ? undoStack[undoStack.length - 1] : null;
    if (!tx) {
      throw new Error('No changes to apply');
    }

    if (tx.type !== 'style' && tx.type !== 'text') {
      throw new Error(`Apply does not support "${tx.type}" transactions yet`);
    }

    state.applyingSnapshot = {
      txId: tx.id,
      txTimestamp: tx.timestamp,
    };

    // Markers indicating the error was already processed by attemptRollbackOnFailure
    const ROLLBACK_MARKERS = [
      '(changes reverted)',
      '(new edits detected',
      '(revert failed)',
      '(unable to revert)',
      '(already reverted)',
    ];

    const isAlreadyProcessed = (err: unknown): boolean =>
      err instanceof Error && ROLLBACK_MARKERS.some((m) => err.message.includes(m));

    try {
      const resp = await sendTransactionToAgent(tx);
      const r = resp as {
        success?: unknown;
        requestId?: unknown;
        sessionId?: unknown;
        error?: unknown;
      } | null;

      if (r && r.success === true) {
        const requestId = typeof r.requestId === 'string' ? r.requestId : undefined;
        const sessionId = typeof r.sessionId === 'string' ? r.sessionId : undefined;

        if (requestId && sessionId && state.executionTracker) {
          state.executionTracker.track(requestId, sessionId);
        }

        state.hmrConsistencyVerifier?.start({
          tx,
          requestId,
          sessionId,
          element: state.selectedElement,
        });

        return { requestId, sessionId };
      }

      const errorMsg = typeof r?.error === 'string' ? r.error : 'Agent request failed';
      throw new Error(attemptRollbackOnFailure(errorMsg));
    } catch (error) {
      if (isAlreadyProcessed(error)) {
        throw error;
      }

      const originalMsg = error instanceof Error ? error.message : String(error);
      throw new Error(attemptRollbackOnFailure(originalMsg));
    } finally {
      state.applyingSnapshot = null;
    }
  }

  /**
   * Apply all applicable transactions to Agent (batch Apply to Code).
   *
   * Phase 1.4: Aggregates the undo stack by element and sends a single
   * batch request. Unlike applyLatestTransaction, this does NOT
   * auto-rollback on failure.
   */
  async function applyAllTransactions(): Promise<{ requestId?: string; sessionId?: string }> {
    const tm = state.transactionManager;
    if (!tm) {
      throw new Error('Transaction manager not ready');
    }

    if (state.applyingSnapshot) {
      throw new Error('Apply already in progress');
    }

    const undoStack = tm.getUndoStack();
    if (undoStack.length === 0) {
      throw new Error('No changes to apply');
    }

    // Block unsupported transaction types
    for (const tx of undoStack) {
      if (tx.type === 'move') {
        throw new Error('Apply does not support reorder operations yet');
      }
      if (tx.type === 'structure') {
        throw new Error('Apply does not support structure operations yet');
      }
      if (tx.type !== 'style' && tx.type !== 'text' && tx.type !== 'class') {
        throw new Error(`Apply does not support "${tx.type}" transactions`);
      }
    }

    const elements = aggregateTransactionsByElement(undoStack);
    if (elements.length === 0) {
      throw new Error('No net changes to apply');
    }

    const latestTx = undoStack[undoStack.length - 1]!;
    state.applyingSnapshot = {
      txId: latestTx.id,
      txTimestamp: latestTx.timestamp,
    };

    try {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
        throw new Error('Chrome runtime API not available');
      }

      const payload: WebEditorApplyBatchPayload = {
        tabId: 0, // Filled by background script
        elements,
        excludedKeys: [], // TODO: Read from storage if exclude feature is implemented
        pageUrl: window.location.href,
      };

      const resp = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_APPLY_BATCH,
        payload,
      });

      const r = resp as {
        success?: unknown;
        requestId?: unknown;
        sessionId?: unknown;
        error?: unknown;
      } | null;

      if (r && r.success === true) {
        const requestId = typeof r.requestId === 'string' ? r.requestId : undefined;
        const sessionId = typeof r.sessionId === 'string' ? r.sessionId : undefined;

        if (requestId && sessionId && state.executionTracker) {
          state.executionTracker.track(requestId, sessionId);
        }

        // Clear transaction history after successful apply
        // (changes are now committed to code; no undo/redo)
        tm.clear();

        // Deselect current element so the selection chip clears
        onDeselect();

        return { requestId, sessionId };
      }

      const errorMsg = typeof r?.error === 'string' ? r.error : 'Agent request failed';
      throw new Error(errorMsg);
    } finally {
      state.applyingSnapshot = null;
    }
  }

  /**
   * Revert a specific element to its baseline state (Phase 2 — selective undo).
   * Creates compensating transactions so the user can undo the revert.
   */
  async function revertElement(
    elementKey: WebEditorElementKey,
  ): Promise<WebEditorRevertElementResponse> {
    const key = String(elementKey ?? '').trim();
    if (!key) {
      return { success: false, error: 'elementKey is required' };
    }

    const tm = state.transactionManager;
    if (!tm) {
      return { success: false, error: 'Transaction manager not ready' };
    }

    if (state.applyingSnapshot) {
      return { success: false, error: 'Cannot revert while Apply is in progress' };
    }

    try {
      const undoStack = tm.getUndoStack();
      const summaries = aggregateTransactionsByElement(undoStack);
      const summary = summaries.find((s) => s.elementKey === key);

      if (!summary) {
        return { success: false, error: 'Element not found in current changes' };
      }

      const element = locateElement(summary.locator);
      if (!element || !element.isConnected) {
        return { success: false, error: 'Failed to locate element for revert' };
      }

      const reverted: NonNullable<WebEditorRevertElementResponse['reverted']> = {};
      let didRevert = false;

      // Revert class first so subsequent locators are based on baseline classes.
      const classChanges = summary.netEffect.classChanges;
      if (classChanges) {
        const baselineClasses = Array.isArray(classChanges.before) ? classChanges.before : [];
        const beforeClasses = (() => {
          try {
            const list = (element as HTMLElement).classList;
            if (list && typeof list[Symbol.iterator] === 'function') {
              return Array.from(list).filter(Boolean);
            }
          } catch {
            // Fallback for non-HTMLElement
          }

          const raw = element.getAttribute('class') ?? '';
          return raw
            .split(/\s+/)
            .map((t) => t.trim())
            .filter(Boolean);
        })();

        const tx = tm.recordClass(element, beforeClasses, baselineClasses);
        if (tx) {
          reverted.class = true;
          didRevert = true;
        }
      }

      // Revert text content
      const textChange = summary.netEffect.textChange;
      if (textChange) {
        const baselineText = String(textChange.before ?? '');
        const beforeText = element.textContent ?? '';

        if (beforeText !== baselineText) {
          element.textContent = baselineText;
          const tx = tm.recordText(element, beforeText, baselineText);
          if (tx) {
            reverted.text = true;
            didRevert = true;
          }
        }
      }

      // Revert styles
      const styleChanges = summary.netEffect.styleChanges;
      if (styleChanges) {
        const before = styleChanges.before ?? {};
        const after = styleChanges.after ?? {};

        const properties = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
          .map((p) => String(p ?? '').trim())
          .filter(Boolean);

        if (properties.length > 0) {
          const handle = tm.beginMultiStyle(element, properties);
          if (handle) {
            handle.set(before);
            const tx = handle.commit({ merge: false });
            if (tx) {
              reverted.style = true;
              didRevert = true;
            }
          }
        }
      }

      if (!didRevert) {
        return { success: false, error: 'No changes were reverted' };
      }

      // Ensure property panel reflects reverted values immediately
      state.propertyPanel?.refresh();

      return { success: true, reverted };
    } catch (error) {
      console.error(`${WEB_EDITOR_V2_LOG_PREFIX} Revert element failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function handleTransactionError(error: unknown): void {
    console.error(`${WEB_EDITOR_V2_LOG_PREFIX} Transaction apply error:`, error);
  }

  return {
    applyLatestTransaction,
    applyAllTransactions,
    revertElement,
    handleTransactionError,
  };
}
