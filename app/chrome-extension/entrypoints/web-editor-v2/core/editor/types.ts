/**
 * Web Editor V2 — shared internal types for the editor module split.
 *
 * These types are shared between the editor orchestrator (editor.ts) and
 * its sibling modules (edit-session, broadcast, transaction-apply,
 * lifecycle). They are not part of the public web-editor API.
 */

import type { ShadowHostManager } from '../../ui/shadow-host';
import type { Toolbar } from '../../ui/toolbar';
import type { Breadcrumbs } from '../../ui/breadcrumbs';
import type { PropertyPanel } from '../../ui/property-panel';
import type { PropsBridge } from '../props-bridge';
import type { CanvasOverlay } from '../../overlay/canvas-overlay';
import type { HandlesController } from '../../overlay/handles-controller';
import type { DragReorderController } from '../../drag/drag-reorder-controller';
import type { EventController } from '../event-controller';
import type { PositionTracker } from '../position-tracker';
import type { SelectionEngine } from '../../selection/selection-engine';
import type { TransactionManager } from '../transaction-manager';
import type { ExecutionTracker } from '../execution-tracker';
import type { HmrConsistencyVerifier } from '../hmr-consistency';
import type { PerfMonitor } from '../perf-monitor';
import type { DesignTokensService } from '../design-tokens';

/** Apply operation snapshot for rollback tracking */
export interface ApplySnapshot {
  txId: string;
  txTimestamp: number;
}

/** Internal editor state — shared mutable container threaded through modules. */
export interface EditorInternalState {
  active: boolean;
  shadowHost: ShadowHostManager | null;
  canvasOverlay: CanvasOverlay | null;
  handlesController: HandlesController | null;
  eventController: EventController | null;
  positionTracker: PositionTracker | null;
  selectionEngine: SelectionEngine | null;
  dragReorderController: DragReorderController | null;
  transactionManager: TransactionManager | null;
  executionTracker: ExecutionTracker | null;
  hmrConsistencyVerifier: HmrConsistencyVerifier | null;
  toolbar: Toolbar | null;
  breadcrumbs: Breadcrumbs | null;
  propertyPanel: PropertyPanel | null;
  /** Runtime props bridge (Phase 7) */
  propsBridge: PropsBridge | null;
  /** Design tokens service (Phase 5.3) */
  tokensService: DesignTokensService | null;
  /** Performance monitor (Phase 5.3) - disabled by default */
  perfMonitor: PerfMonitor | null;
  /** Cleanup function for perf monitor hotkey */
  perfHotkeyCleanup: (() => void) | null;
  /** Currently hovered element (for hover highlight) */
  hoveredElement: Element | null;
  /** One-shot flag: whether next hover rect update should animate */
  pendingHoverTransition: boolean;
  /** Currently selected element (for selection highlight) */
  selectedElement: Element | null;
  /** Snapshot of transaction being applied (for rollback on failure) */
  applyingSnapshot: ApplySnapshot | null;
  /** Floating toolbar position (viewport coordinates), null when docked */
  toolbarPosition: { left: number; top: number } | null;
  /** Floating property panel position (viewport coordinates), null when anchored */
  propertyPanelPosition: { left: number; top: number } | null;
  /** Cleanup for window resize clamping (floating UI) */
  uiResizeCleanup: (() => void) | null;
}

/** Factory result for the broadcast module */
export interface Broadcaster {
  broadcastTxChanged(action: import('@/common/web-editor-types').WebEditorTxChangeAction): void;
  broadcastSelectionChanged(element: Element | null): void;
  broadcastEditorCleared(): void;
  /** Cancel any pending debounced tx broadcast; call from stop(). */
  cancelPending(): void;
}

/** Factory result for the edit-session module */
export interface EditSessionController {
  startEdit(
    element: Element,
    modifiers: import('../event-controller').EventModifiers,
  ): boolean;
  commitEdit(): void;
  cancelEdit(): void;
  /** Whether an edit is currently in progress. */
  hasSession(): boolean;
  /** The element currently being edited, or null. */
  currentElement(): HTMLElement | null;
}

/** Factory result for the transaction-apply module */
export interface TransactionApplyController {
  applyLatestTransaction(): Promise<{ requestId?: string; sessionId?: string }>;
  applyAllTransactions(): Promise<{ requestId?: string; sessionId?: string }>;
  revertElement(
    elementKey: import('@/common/web-editor-types').WebEditorElementKey,
  ): Promise<import('@/common/web-editor-types').WebEditorRevertElementResponse>;
  handleTransactionError(error: unknown): void;
}
