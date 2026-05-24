/**
 * Web Editor V2 — Lifecycle (start/stop) for the editor subsystem.
 *
 * Owns the bring-up and tear-down of every subsystem (shadow host, canvas,
 * controllers, toolbar, breadcrumbs, property panel, ...). Handlers and
 * orchestrator-level helpers (handleHover/Select/...) are injected via
 * `LifecycleDeps.handlers` to keep cross-cluster wiring explicit.
 */

import type { ExecutionState } from '../execution-tracker';
import type { EventModifiers } from '../event-controller';
import type { TrackedRects } from '../position-tracker';
import type { TransactionChangeEvent } from '../transaction-manager';
import { mountShadowHost } from '../../ui/shadow-host';
import { createToolbar } from '../../ui/toolbar';
import { createBreadcrumbs } from '../../ui/breadcrumbs';
import { createPropertyPanel } from '../../ui/property-panel';
import { createPropsBridge } from '../props-bridge';
import { createCanvasOverlay } from '../../overlay/canvas-overlay';
import { createHandlesController } from '../../overlay/handles-controller';
import { createDragReorderController } from '../../drag/drag-reorder-controller';
import { createEventController } from '../event-controller';
import { createPositionTracker } from '../position-tracker';
import { createSelectionEngine } from '../../selection/selection-engine';
import { createTransactionManager } from '../transaction-manager';
import { createExecutionTracker } from '../execution-tracker';
import { createHmrConsistencyVerifier } from '../hmr-consistency';
import { createPerfMonitor } from '../perf-monitor';
import { createDesignTokensService } from '../design-tokens';
import { locateElement } from '../locator';
import { WEB_EDITOR_V2_LOG_PREFIX } from '../../constants';
import type { EditorInternalState } from './types';

/** Orchestrator-provided handlers. Lifecycle only wires them; it never owns them. */
export interface LifecycleHandlers {
  handleHover(element: Element | null): void;
  handleSelect(element: Element, modifiers: EventModifiers): void;
  handleDeselect(): void;
  handlePositionUpdate(rects: TrackedRects): void;
  handleTransactionChange(event: TransactionChangeEvent): void;
  handleTransactionError(error: unknown): void;
  /** Edit-session entry point invoked from EventController. */
  startEdit(element: Element, modifiers: EventModifiers): boolean;
  /** Commit any in-progress edit (called from stop() before cleanup). */
  commitEditIfActive(): void;
  /** Apply path used by toolbar's "Apply" button. */
  applyAllTransactions(): Promise<{ requestId?: string; sessionId?: string }>;
  /** Required by TransactionManager's editor-UI event filter. */
  isEventFromEditingElement(event: Event): boolean;
  /** Default modifiers for programmatic selections (breadcrumb/property panel). */
  defaultModifiers: EventModifiers;
  /** Called from stop's finally block — clears UI chips in the sidepanel. */
  broadcastEditorCleared(): void;
  /** Called from stop — cancels any debounced TX broadcast. */
  cancelPendingBroadcasts(): void;
  /** Read-only access to the currently selected element (closure-friendly). */
  getSelectedElement(): Element | null;
}

export interface LifecycleDeps {
  state: EditorInternalState;
  handlers: LifecycleHandlers;
}

export interface LifecycleController {
  start(): void;
  stop(): void;
}

export function createLifecycle({ state, handlers }: LifecycleDeps): LifecycleController {
  function start(): void {
    if (state.active) {
      console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Already active`);
      return;
    }

    try {
      // Mount Shadow DOM host
      state.shadowHost = mountShadowHost({});

      // Initialize Canvas Overlay
      const elements = state.shadowHost.getElements();
      if (!elements?.overlayRoot) {
        throw new Error('Shadow host overlayRoot not available');
      }
      state.canvasOverlay = createCanvasOverlay({
        container: elements.overlayRoot,
      });

      // Initialize Performance Monitor (Phase 5.3) — disabled by default
      state.perfMonitor = createPerfMonitor({
        container: elements.overlayRoot,
        fpsUiIntervalMs: 500,
        memorySampleIntervalMs: 1000,
      });

      // Register hotkey: Ctrl/Cmd + Shift + P toggles perf monitor
      const perfHotkeyHandler = (event: KeyboardEvent): void => {
        // Ignore key repeats to avoid rapid toggles when holding the shortcut
        if (event.repeat) return;

        const isMod = event.metaKey || event.ctrlKey;
        if (!isMod) return;
        if (!event.shiftKey) return;
        if (event.altKey) return;

        const key = (event.key || '').toLowerCase();
        if (key !== 'p') return;

        const monitor = state.perfMonitor;
        if (!monitor) return;

        monitor.toggle();

        // Prevent browser shortcuts (e.g., print dialog)
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      };

      const hotkeyOptions: AddEventListenerOptions = { capture: true, passive: false };
      window.addEventListener('keydown', perfHotkeyHandler, hotkeyOptions);
      state.perfHotkeyCleanup = () => {
        window.removeEventListener('keydown', perfHotkeyHandler, hotkeyOptions);
      };

      // Selection Engine for intelligent element picking
      state.selectionEngine = createSelectionEngine({
        isOverlayElement: state.shadowHost.isOverlayElement,
      });

      // Position Tracker for scroll/resize synchronization
      state.positionTracker = createPositionTracker({
        onPositionUpdate: handlers.handlePositionUpdate,
      });

      // Transaction Manager (undo/redo)
      // Filter Shadow UI events AND editing-element events so contentEditable
      // can use the native Ctrl/Cmd+Z without triggering global undo.
      state.transactionManager = createTransactionManager({
        enableKeyBindings: true,
        isEventFromEditorUi: (event) => {
          if (state.shadowHost?.isEventFromUi(event)) return true;
          if (handlers.isEventFromEditingElement(event)) return true;
          return false;
        },
        onChange: handlers.handleTransactionChange,
        onApplyError: handlers.handleTransactionError,
      });

      // Resize Handles Controller (Phase 4.9)
      state.handlesController = createHandlesController({
        container: elements.overlayRoot,
        canvasOverlay: state.canvasOverlay,
        transactionManager: state.transactionManager,
        positionTracker: state.positionTracker,
      });

      // Drag Reorder Controller (Phase 2.4-2.6)
      state.dragReorderController = createDragReorderController({
        isOverlayElement: state.shadowHost.isOverlayElement,
        uiRoot: elements.uiRoot,
        canvasOverlay: state.canvasOverlay,
        positionTracker: state.positionTracker,
        transactionManager: state.transactionManager,
      });

      // Event Controller for interaction handling
      // SelectionEngine.findBestTargetFromEvent handles click; hover uses
      // fast elementFromPoint for 60FPS performance.
      state.eventController = createEventController({
        isOverlayElement: state.shadowHost.isOverlayElement,
        onHover: handlers.handleHover,
        onSelect: handlers.handleSelect,
        onDeselect: handlers.handleDeselect,
        onStartEdit: handlers.startEdit,
        findTargetForSelect: (_x, _y, modifiers, event) =>
          state.selectionEngine?.findBestTargetFromEvent(event, modifiers) ?? null,
        getSelectedElement: handlers.getSelectedElement,
        onStartDrag: (ev) => state.dragReorderController?.onDragStart(ev) ?? false,
        onDragMove: (ev) => state.dragReorderController?.onDragMove(ev),
        onDragEnd: (ev) => state.dragReorderController?.onDragEnd(ev),
        onDragCancel: (ev) => state.dragReorderController?.onDragCancel(ev),
      });

      // ExecutionTracker for Agent execution status (Phase 3.10)
      state.executionTracker = createExecutionTracker({
        onStatusChange: (execState: ExecutionState) => {
          // Only update toolbar directly if the verifier isn't handling it.
          // When the verifier is active it controls the toolbar status after
          // execution completes.
          const verifierPhase = state.hmrConsistencyVerifier?.getSnapshot().phase ?? 'idle';
          const verifierActive = verifierPhase !== 'idle';

          if (!verifierActive || execState.status !== 'completed') {
            const statusMap: Record<string, string> = {
              pending: 'applying',
              starting: 'starting',
              running: 'running',
              locating: 'locating',
              applying: 'applying',
              completed: 'completed',
              failed: 'failed',
              error: 'failed', // Server may return 'error', treat same as 'failed'
              timeout: 'timeout',
              cancelled: 'cancelled',
            };
            type ToolbarStatusType = Parameters<NonNullable<typeof state.toolbar>['setStatus']>[0];
            const toolbarStatus = (statusMap[execState.status] ?? 'running') as ToolbarStatusType;
            state.toolbar?.setStatus(toolbarStatus, execState.message);
          }

          // Forward to HMR consistency verifier (Phase 4.8)
          state.hmrConsistencyVerifier?.onExecutionStatus(execState);
        },
      });

      // HMR Consistency Verifier (Phase 4.8)
      state.hmrConsistencyVerifier = createHmrConsistencyVerifier({
        transactionManager: state.transactionManager,
        getSelectedElement: handlers.getSelectedElement,
        onReselect: (element) => handlers.handleSelect(element, handlers.defaultModifiers),
        onDeselect: handlers.handleDeselect,
        setToolbarStatus: (status, message) => state.toolbar?.setStatus(status, message),
        isOverlayElement: state.shadowHost?.isOverlayElement,
        selectionEngine: state.selectionEngine ?? undefined,
      });

      // Toolbar UI
      state.toolbar = createToolbar({
        container: elements.uiRoot,
        dock: 'top',
        initialPosition: state.toolbarPosition,
        onPositionChange: (position) => {
          state.toolbarPosition = position;
        },
        getApplyBlockReason: () => {
          const tm = state.transactionManager;
          if (!tm) return undefined;

          const undoStack = tm.getUndoStack();
          if (undoStack.length === 0) return undefined;

          // O(n) type check only — full net-effect check happens in
          // applyAllTransactions to avoid perf issues during frequent
          // merge events.
          for (const tx of undoStack) {
            if (tx.type === 'move') {
              return 'Apply does not support reorder operations yet';
            }
            if (tx.type === 'structure') {
              return 'Apply does not support structure operations yet';
            }
            if (tx.type !== 'style' && tx.type !== 'text' && tx.type !== 'class') {
              return `Apply does not support "${tx.type}" transactions`;
            }
          }

          return undefined;
        },
        getSelectedElement: handlers.getSelectedElement,
        onStructure: (data) => {
          const target = handlers.getSelectedElement();
          if (!target) return;

          const tm = state.transactionManager;
          if (!tm) return;

          const tx = tm.applyStructure(target, data);
          if (!tx) return;

          // Update selection based on action type:
          //   wrap/stack → select new wrapper
          //   unwrap     → select unwrapped child
          //   duplicate  → select clone
          //   delete     → deselect
          if (data.action === 'delete') {
            handlers.handleDeselect();
          } else {
            // tx.targetLocator points to the new selection target.
            const newTarget = locateElement(tx.targetLocator);
            if (newTarget && newTarget.isConnected) {
              handlers.handleSelect(newTarget, handlers.defaultModifiers);
            }
          }
        },
        onApply: handlers.applyAllTransactions,
        onUndo: () => state.transactionManager?.undo(),
        onRedo: () => state.transactionManager?.redo(),
        onRequestClose: () => stop(),
      });

      // Initialize toolbar history display
      state.toolbar.setHistory(
        state.transactionManager.getUndoStack().length,
        state.transactionManager.getRedoStack().length,
      );

      // Breadcrumbs UI (selected element ancestry)
      state.breadcrumbs = createBreadcrumbs({
        container: elements.uiRoot,
        dock: 'top',
        onSelect: (element) => {
          if (element.isConnected) {
            handlers.handleSelect(element, handlers.defaultModifiers);
          }
        },
      });

      // Props Bridge (Phase 7)
      state.propsBridge = createPropsBridge({});

      // Design Tokens Service (Phase 5.3)
      state.tokensService = createDesignTokensService();

      // Property Panel (Phase 3)
      state.propertyPanel = createPropertyPanel({
        container: elements.uiRoot,
        transactionManager: state.transactionManager,
        propsBridge: state.propsBridge,
        tokensService: state.tokensService,
        initialPosition: state.propertyPanelPosition,
        onPositionChange: (position) => {
          state.propertyPanelPosition = position;
        },
        defaultTab: 'design',
        onSelectElement: (element) => {
          if (element.isConnected) {
            handlers.handleSelect(element, handlers.defaultModifiers);
          }
        },
        onRequestClose: () => stop(),
      });

      // Clamp floating UI positions on window resize (session-only persistence)
      let uiResizeRafId: number | null = null;

      const clampFloatingUi = (): void => {
        const toolbarPos = state.toolbarPosition;
        const panelPos = state.propertyPanelPosition;

        if (state.toolbar && toolbarPos) {
          state.toolbar.setPosition(toolbarPos);
        }
        if (state.propertyPanel && panelPos) {
          state.propertyPanel.setPosition(panelPos);
        }
      };

      const onWindowResize = (): void => {
        if (!state.active) return;
        if (uiResizeRafId !== null) return;
        uiResizeRafId = window.requestAnimationFrame(() => {
          uiResizeRafId = null;
          clampFloatingUi();
        });
      };

      window.addEventListener('resize', onWindowResize, { passive: true });
      state.uiResizeCleanup = () => {
        window.removeEventListener('resize', onWindowResize);
        if (uiResizeRafId !== null) {
          window.cancelAnimationFrame(uiResizeRafId);
          uiResizeRafId = null;
        }
      };

      // Ensure restored positions are visible on first render
      clampFloatingUi();

      state.active = true;
      console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Started`);
    } catch (error) {
      // Cleanup on failure (reverse order)
      state.uiResizeCleanup?.();
      state.uiResizeCleanup = null;
      state.propertyPanel?.dispose();
      state.propertyPanel = null;
      state.tokensService?.dispose();
      state.tokensService = null;
      state.propsBridge?.dispose();
      state.propsBridge = null;
      state.breadcrumbs?.dispose();
      state.breadcrumbs = null;
      state.toolbar?.dispose();
      state.toolbar = null;
      state.eventController?.dispose();
      state.eventController = null;
      state.dragReorderController?.dispose();
      state.dragReorderController = null;
      state.handlesController?.dispose();
      state.handlesController = null;
      state.transactionManager?.dispose();
      state.transactionManager = null;
      state.positionTracker?.dispose();
      state.positionTracker = null;
      state.selectionEngine?.dispose();
      state.selectionEngine = null;
      state.perfHotkeyCleanup?.();
      state.perfHotkeyCleanup = null;
      state.perfMonitor?.dispose();
      state.perfMonitor = null;
      state.canvasOverlay?.dispose();
      state.canvasOverlay = null;
      state.shadowHost?.dispose();
      state.shadowHost = null;
      state.hoveredElement = null;
      state.selectedElement = null;
      state.applyingSnapshot = null;
      state.active = false;

      console.error(`${WEB_EDITOR_V2_LOG_PREFIX} Failed to start:`, error);
    }
  }

  function stop(): void {
    if (!state.active) {
      return;
    }

    state.active = false;

    // Cancel any debounced TX broadcast (Phase 1.4)
    handlers.cancelPendingBroadcasts();

    try {
      // Cleanup in reverse order of initialization

      // Commit any in-progress text edit before cleanup
      handlers.commitEditIfActive();

      // Resize listener for floating UI
      state.uiResizeCleanup?.();
      state.uiResizeCleanup = null;

      // Property Panel (Phase 3)
      state.propertyPanel?.dispose();
      state.propertyPanel = null;

      // Design Tokens Service (Phase 5.3)
      state.tokensService?.dispose();
      state.tokensService = null;

      // Props Bridge (Phase 7) — best effort cleanup
      void state.propsBridge?.cleanup();
      state.propsBridge = null;

      // Breadcrumbs UI
      state.breadcrumbs?.dispose();
      state.breadcrumbs = null;

      // Toolbar UI
      state.toolbar?.dispose();
      state.toolbar = null;

      // Event Controller (stops event interception)
      state.eventController?.dispose();
      state.eventController = null;

      // Drag Reorder Controller
      state.dragReorderController?.dispose();
      state.dragReorderController = null;

      // Resize Handles Controller (Phase 4.9)
      state.handlesController?.dispose();
      state.handlesController = null;

      // Execution Tracker (Phase 3.10)
      state.executionTracker?.dispose();
      state.executionTracker = null;

      // HMR Consistency Verifier (Phase 4.8)
      state.hmrConsistencyVerifier?.dispose();
      state.hmrConsistencyVerifier = null;

      // Transaction Manager (clears history)
      state.transactionManager?.dispose();
      state.transactionManager = null;

      // Position Tracker (stops scroll/resize monitoring)
      state.positionTracker?.dispose();
      state.positionTracker = null;

      // Selection Engine
      state.selectionEngine?.dispose();
      state.selectionEngine = null;

      // Performance Monitor (Phase 5.3)
      state.perfHotkeyCleanup?.();
      state.perfHotkeyCleanup = null;
      state.perfMonitor?.dispose();
      state.perfMonitor = null;

      // Canvas Overlay
      state.canvasOverlay?.dispose();
      state.canvasOverlay = null;

      // Shadow DOM host
      state.shadowHost?.dispose();
      state.shadowHost = null;

      // Clear element references and apply state
      state.hoveredElement = null;
      state.selectedElement = null;
      state.applyingSnapshot = null;

      console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Stopped`);
    } catch (error) {
      console.error(`${WEB_EDITOR_V2_LOG_PREFIX} Error during cleanup:`, error);

      // Force cleanup
      state.propertyPanel = null;
      state.propsBridge = null;
      state.breadcrumbs = null;
      state.toolbar = null;
      state.eventController = null;
      state.dragReorderController = null;
      state.handlesController = null;
      state.transactionManager = null;
      state.positionTracker = null;
      state.selectionEngine = null;
      state.perfHotkeyCleanup = null;
      state.perfMonitor = null;
      state.canvasOverlay = null;
      state.shadowHost = null;
      state.hoveredElement = null;
      state.selectedElement = null;
      state.applyingSnapshot = null;
    } finally {
      // Always broadcast clear state to sidepanel (removes chips)
      handlers.broadcastEditorCleared();
    }
  }

  return { start, stop };
}
