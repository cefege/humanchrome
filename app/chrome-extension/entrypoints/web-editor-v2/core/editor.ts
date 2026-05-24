/**
 * Web Editor V2 Core — Orchestrator
 *
 * Main factory for the visual editor. Owns the shared mutable state and
 * the orchestrator-level event handlers (hover/select/deselect/position),
 * then delegates the major clusters to sibling modules under `./editor/`:
 *
 *   - editor/edit-session     — inline text edits (Phase 2.7)
 *   - editor/broadcast        — AgentChat tx/selection broadcasts (Phase 1.4)
 *   - editor/transaction-apply — Apply-to-Code pipeline + revertElement
 *   - editor/lifecycle        — start()/stop() bring-up and tear-down
 */

import type {
  WebEditorState,
  WebEditorTxChangeAction,
  WebEditorV2Api,
} from '@/common/web-editor-types';
import { WEB_EDITOR_V2_VERSION, WEB_EDITOR_V2_LOG_PREFIX } from '../constants';
import type { EventModifiers } from './event-controller';
import type { TrackedRects } from './position-tracker';
import type { TransactionChangeEvent } from './transaction-manager';
import type { EditorInternalState } from './editor/types';
import { createBroadcaster } from './editor/broadcast';
import { createEditSession } from './editor/edit-session';
import { createTransactionApply } from './editor/transaction-apply';
import { createLifecycle } from './editor/lifecycle';

/**
 * Create the Web Editor V2 instance.
 *
 * Factory function that returns the public WebEditorV2Api, exposed on
 * `window.__MCP_WEB_EDITOR_V2__`.
 */
export function createWebEditorV2(): WebEditorV2Api {
  const state: EditorInternalState = {
    active: false,
    shadowHost: null,
    canvasOverlay: null,
    handlesController: null,
    eventController: null,
    positionTracker: null,
    selectionEngine: null,
    dragReorderController: null,
    transactionManager: null,
    executionTracker: null,
    hmrConsistencyVerifier: null,
    toolbar: null,
    breadcrumbs: null,
    propertyPanel: null,
    propsBridge: null,
    tokensService: null,
    perfMonitor: null,
    perfHotkeyCleanup: null,
    hoveredElement: null,
    pendingHoverTransition: false,
    selectedElement: null,
    applyingSnapshot: null,
    toolbarPosition: null,
    propertyPanelPosition: null,
    uiResizeCleanup: null,
  };

  /** Default modifiers for programmatic selection (e.g., from breadcrumbs). */
  const DEFAULT_MODIFIERS: EventModifiers = {
    alt: false,
    shift: false,
    ctrl: false,
    meta: false,
  };

  // ===========================================================================
  // Module wiring
  //
  // The clusters reference each other (e.g., edit-session needs to drive
  // selection, transaction-apply needs to deselect after batch apply), so
  // we instantiate them in dependency order and pass cross-module callbacks
  // through dependency injection.
  // ===========================================================================

  const broadcaster = createBroadcaster({ state });

  const editSessionController = createEditSession({
    state,
    selectElement: (element, modifiers) => handleSelect(element, modifiers),
  });

  const transactionApply = createTransactionApply({
    state,
    onDeselect: () => handleDeselect(),
  });

  // ===========================================================================
  // Event Handlers (wired to EventController callbacks)
  // ===========================================================================

  /** Handle hover state changes from EventController. */
  function handleHover(element: Element | null): void {
    const prevElement = state.hoveredElement;
    state.hoveredElement = element;

    // Animate hover rect only when switching between two valid elements.
    const shouldAnimate = prevElement !== null && element !== null && prevElement !== element;
    state.pendingHoverTransition = shouldAnimate;

    // Delegate position tracking; forceUpdate avoids extra rAF delay.
    if (state.positionTracker) {
      state.positionTracker.setHoverElement(element);
      state.positionTracker.forceUpdate();
    }
  }

  /** Handle element selection from EventController. */
  function handleSelect(element: Element, modifiers: EventModifiers): void {
    // Commit any in-progress edit when selecting a different element
    if (
      editSessionController.hasSession() &&
      editSessionController.currentElement() !== element
    ) {
      editSessionController.commitEdit();
    }

    state.selectedElement = element;
    state.hoveredElement = null;

    // Clear hover, set selection, force immediate update.
    if (state.positionTracker) {
      state.positionTracker.setHoverElement(null);
      state.positionTracker.setSelectionElement(element);
      state.positionTracker.forceUpdate();
    }

    // Update breadcrumbs to show element ancestry
    state.breadcrumbs?.setTarget(element);

    // Update property panel with selected element
    state.propertyPanel?.setTarget(element);

    // Update resize handles target (Phase 4.9)
    state.handlesController?.setTarget(element);

    // Notify HMR consistency verifier of selection change (Phase 4.8)
    state.hmrConsistencyVerifier?.onSelectionChange(element);

    // Broadcast selection to sidepanel for AgentChat context
    broadcaster.broadcastSelectionChanged(element);

    // Log selection with modifier info for debugging
    const modInfo = modifiers.alt ? ' (Alt: drill-up)' : '';
    console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Selected${modInfo}:`, element.tagName, element);
  }

  /** Handle deselection (ESC key) from EventController. */
  function handleDeselect(): void {
    state.selectedElement = null;

    // Clear selection tracking and force immediate update
    if (state.positionTracker) {
      state.positionTracker.setSelectionElement(null);
      state.positionTracker.forceUpdate();
    }

    // Clear breadcrumbs
    state.breadcrumbs?.setTarget(null);

    // Clear property panel
    state.propertyPanel?.setTarget(null);

    // Hide resize handles (Phase 4.9)
    state.handlesController?.setTarget(null);

    // Notify HMR consistency verifier of deselection (Phase 4.8)
    state.hmrConsistencyVerifier?.onSelectionChange(null);

    // Broadcast deselection to sidepanel
    broadcaster.broadcastSelectionChanged(null);

    console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Deselected`);
  }

  /** Handle position updates from PositionTracker (scroll/resize sync). */
  function handlePositionUpdate(rects: TrackedRects): void {
    // Anchor breadcrumbs to the selection rect (viewport coordinates)
    state.breadcrumbs?.setAnchorRect(rects.selection);

    // Consume one-shot animation flag (must read before clearing).
    // Only set when hover element changes, not for scroll/resize.
    const animateHover = state.pendingHoverTransition;
    state.pendingHoverTransition = false;

    if (!state.canvasOverlay) return;

    // Update canvas overlay with new positions
    state.canvasOverlay.setHoverRect(rects.hover, { animate: animateHover });
    state.canvasOverlay.setSelectionRect(rects.selection);

    // Sync resize handles with latest selection rect (Phase 4.9)
    state.handlesController?.setSelectionRect(rects.selection);

    // Force immediate render so canvas updates in the same frame as
    // position calculation.
    state.canvasOverlay.render();
  }

  /** Handle transaction changes from TransactionManager. */
  function handleTransactionChange(event: TransactionChangeEvent): void {
    const { action, undoCount, redoCount } = event;
    console.log(
      `${WEB_EDITOR_V2_LOG_PREFIX} Transaction: ${action} (undo: ${undoCount}, redo: ${redoCount})`,
    );

    // Update toolbar UI with undo/redo counts
    state.toolbar?.setHistory(undoCount, redoCount);

    // Refresh property panel after undo/redo to reflect current styles
    if (action === 'undo' || action === 'redo') {
      state.propertyPanel?.refresh();
    }

    // Broadcast aggregated TX state for AgentChat integration (Phase 1.4)
    broadcaster.broadcastTxChanged(action as WebEditorTxChangeAction);

    // Notify HMR consistency verifier of transaction change (Phase 4.8)
    state.hmrConsistencyVerifier?.onTransactionChange(event);
  }

  // ===========================================================================
  // Lifecycle (depends on every handler above)
  // ===========================================================================

  const lifecycle = createLifecycle({
    state,
    handlers: {
      handleHover,
      handleSelect,
      handleDeselect,
      handlePositionUpdate,
      handleTransactionChange,
      handleTransactionError: transactionApply.handleTransactionError,
      startEdit: editSessionController.startEdit,
      commitEditIfActive: () => {
        if (editSessionController.hasSession()) {
          editSessionController.commitEdit();
        }
      },
      applyAllTransactions: transactionApply.applyAllTransactions,
      isEventFromEditingElement: (event) => {
        const editingElement = editSessionController.currentElement();
        if (!editingElement) return false;
        try {
          const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
          if (path?.some((node) => node === editingElement)) return true;
        } catch {
          // Fallback
          const target = event.target;
          if (target instanceof Node && editingElement.contains(target)) return true;
        }
        return false;
      },
      defaultModifiers: DEFAULT_MODIFIERS,
      broadcastEditorCleared: broadcaster.broadcastEditorCleared,
      cancelPendingBroadcasts: broadcaster.cancelPending,
      getSelectedElement: () => state.selectedElement,
    },
  });

  // ===========================================================================
  // Public API surface
  // ===========================================================================

  /**
   * Clear current selection (called from sidepanel after send).
   * Triggers handleDeselect, which broadcasts null selection to sidepanel.
   */
  function clearSelection(): void {
    if (!state.selectedElement) {
      // Already deselected
      return;
    }

    // Use EventController to properly transition to hover mode.
    // This triggers onDeselect → handleDeselect → broadcastSelectionChanged(null).
    if (state.eventController) {
      state.eventController.setMode('hover');

      // Edge case: if setMode('hover') didn't trigger deselect (e.g., already
      // in hover mode but selectedElement was set programmatically), call
      // handleDeselect directly.
      if (state.selectedElement) {
        handleDeselect();
      }
    } else {
      // Fallback if eventController not available
      handleDeselect();
    }

    console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Selection cleared (from sidepanel)`);
  }

  /** Toggle the editor on/off. */
  function toggle(): boolean {
    if (state.active) {
      lifecycle.stop();
    } else {
      lifecycle.start();
    }
    return state.active;
  }

  /** Get current editor state. */
  function getState(): WebEditorState {
    return {
      active: state.active,
      version: WEB_EDITOR_V2_VERSION,
    };
  }

  return {
    start: lifecycle.start,
    stop: lifecycle.stop,
    toggle,
    getState,
    revertElement: transactionApply.revertElement,
    clearSelection,
  };
}
