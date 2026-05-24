/**
 * Transaction Manager
 *
 * Locator-based undo/redo system for inline style edits.
 *
 * Design principles:
 * - Uses CSS selectors (not DOM references) for element identification
 * - Supports transaction merging for continuous edits (e.g., slider drag)
 * - Provides handle-based API for batched operations
 * - Emits change events for UI synchronization
 *
 * Implementation is split across sibling modules in `./transaction-manager/`:
 * - `dom-helpers.ts` — pure DOM utilities (style/class/structure)
 * - `factories.ts`   — Transaction record builders + target validation
 * - `appliers.ts`    — undo/redo application + merge predicates
 *
 * This file owns the public types, the manager class itself, and the
 * keyboard binding plumbing. The split is structural only — public exports
 * are unchanged, so existing importers don't need updates.
 */

import type {
  ElementLocator,
  MoveOperationData,
  MoveTransactionData,
  StructureOperationData,
  Transaction,
  WebEditorElementKey,
} from '@/common/web-editor-types';
import { Disposer } from '../utils/disposables';
import { generateStableElementKey } from './element-key';
import { createElementLocator, locatorKey } from './locator';
import {
  applyClassListToElement,
  buildInsertAfterPosition,
  getInlineStyle,
  isSameStringList,
  normalizeClassList,
  normalizePropertyName,
  readClassList,
  readInlineStyleMap,
  readStyleValue,
  stripIdsFromSubtree,
  unwrapSingleChildContainer,
  wrapElementWithContainer,
  writeStyleValue,
} from './transaction-manager/dom-helpers';
import {
  applyTransaction,
  canMerge,
  mergeInto,
} from './transaction-manager/appliers';
import {
  buildMoveOperationData,
  createClassTransaction,
  createMoveTransaction,
  createStructureTransaction,
  createStyleTransaction,
  createStyleTransactionFromStyles,
  createTextTransaction,
  generateTransactionId,
  isDisallowedMoveElement,
  isDisallowedStructureContainer,
  isDisallowedStructureTarget,
} from './transaction-manager/factories';

// =============================================================================
// Types
// =============================================================================

/** Change event action types */
export type TransactionChangeAction = 'push' | 'merge' | 'undo' | 'redo' | 'clear' | 'rollback';

/** Change event emitted when transaction state changes */
export interface TransactionChangeEvent {
  action: TransactionChangeAction;
  transaction: Transaction | null;
  undoCount: number;
  redoCount: number;
}

/** Options for creating the Transaction Manager */
export interface TransactionManagerOptions {
  /** Maximum transactions to keep in history (oldest dropped) */
  maxHistory?: number;
  /** Time window (ms) for merging consecutive edits to same property */
  mergeWindowMs?: number;
  /** Enable Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z keyboard shortcuts */
  enableKeyBindings?: boolean;
  /** Check if event is from editor UI (to ignore keybindings) */
  isEventFromEditorUi?: (event: Event) => boolean;
  /** Custom time source (for testing) */
  now?: () => number;
  /** Called when transaction state changes */
  onChange?: (event: TransactionChangeEvent) => void;
  /** Called when applying a transaction fails */
  onApplyError?: (error: unknown) => void;
}

/** Handle for an in-progress style transaction (for batching) */
export interface StyleTransactionHandle {
  /** Unique handle ID */
  readonly id: string;
  /** CSS property being edited */
  readonly property: string;
  /** Target element locator */
  readonly targetLocator: ElementLocator;
  /** Update the style value (live preview) */
  set(value: string): void;
  /** Commit the transaction and record to history */
  commit(options?: { merge?: boolean }): Transaction | null;
  /** Rollback to original value without recording */
  rollback(): void;
}

/**
 * Handle for an in-progress multi-style transaction (Phase 4.9)
 *
 * Used for operations that modify multiple CSS properties atomically,
 * such as resize handles (width + height) or position handles (top + left).
 */
export interface MultiStyleTransactionHandle {
  /** Unique handle ID */
  readonly id: string;
  /** CSS properties being edited (normalized, unique) */
  readonly properties: readonly string[];
  /** Target element locator */
  readonly targetLocator: ElementLocator;
  /**
   * Update one or more style values (live preview).
   * Keys outside the declared `properties` are ignored.
   */
  set(values: Record<string, string>): void;
  /** Commit the transaction and record to history */
  commit(options?: { merge?: boolean }): Transaction | null;
  /** Rollback all tracked properties to original values without recording */
  rollback(): void;
}

/** Handle for an in-progress move transaction (Phase 2.4-2.6) */
export interface MoveTransactionHandle {
  /** Unique handle ID */
  readonly id: string;
  /** Locator for the dragged element at drag start */
  readonly beforeLocator: ElementLocator;
  /** Original location */
  readonly from: MoveOperationData;
  /** Commit the move and record to history (call after DOM move) */
  commit(targetAfterMove: Element): Transaction | null;
  /** Cancel the move session without recording */
  cancel(): void;
}

/** Transaction Manager public interface */
export interface TransactionManager {
  /** Begin an interactive style edit (returns handle for batching) */
  beginStyle(target: Element, property: string): StyleTransactionHandle | null;
  /**
   * Begin an interactive multi-style edit (Phase 4.9)
   *
   * For operations that modify multiple CSS properties atomically.
   * Returns null if element doesn't support inline styles or properties list is empty.
   */
  beginMultiStyle(target: Element, properties: string[]): MultiStyleTransactionHandle | null;
  /** Begin a drag move transaction (records before state at drag start) */
  beginMove(target: Element): MoveTransactionHandle | null;
  /** Apply a style change immediately and record transaction */
  applyStyle(
    target: Element,
    property: string,
    value: string,
    options?: { merge?: boolean },
  ): Transaction | null;
  /** Record a style transaction without applying (for external changes) */
  recordStyle(
    locator: ElementLocator,
    property: string,
    beforeValue: string,
    afterValue: string,
    options?: { merge?: boolean },
  ): Transaction | null;
  /** Record a text transaction for contentEditable edit (Phase 2.7) */
  recordText(target: Element, beforeText: string, afterText: string): Transaction | null;
  /** Record a class list change and create transaction (Phase 4.7) */
  recordClass(target: Element, beforeClasses: string[], afterClasses: string[]): Transaction | null;
  /** Apply a structure operation and record transaction (Phase 5.5) */
  applyStructure(target: Element, data: StructureOperationData): Transaction | null;
  /** Undo the last transaction */
  undo(): Transaction | null;
  /** Redo the last undone transaction */
  redo(): Transaction | null;
  /** Check if undo is available */
  canUndo(): boolean;
  /** Check if redo is available */
  canRedo(): boolean;
  /** Get current undo stack (readonly) */
  getUndoStack(): readonly Transaction[];
  /** Get current redo stack (readonly) */
  getRedoStack(): readonly Transaction[];
  /** Clear all transaction history */
  clear(): void;
  /** Cleanup resources */
  dispose(): void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_HISTORY = 100;
const DEFAULT_MERGE_WINDOW_MS = 800;

const KEYBIND_OPTIONS: AddEventListenerOptions = {
  capture: true,
  passive: false,
};

// =============================================================================
// Transaction Manager Implementation
// =============================================================================

/**
 * Create a Transaction Manager instance
 */
export function createTransactionManager(
  options: TransactionManagerOptions = {},
): TransactionManager {
  const disposer = new Disposer();

  // Configuration
  const maxHistory = Math.max(1, options.maxHistory ?? DEFAULT_MAX_HISTORY);
  const mergeWindowMs = Math.max(0, options.mergeWindowMs ?? DEFAULT_MERGE_WINDOW_MS);
  const now = options.now ?? (() => Date.now());

  // State
  const undoStack: Transaction[] = [];
  const redoStack: Transaction[] = [];

  // ==========================================================================
  // Event Emission
  // ==========================================================================

  function emit(action: TransactionChangeAction, transaction: Transaction | null): void {
    options.onChange?.({
      action,
      transaction,
      undoCount: undoStack.length,
      redoCount: redoStack.length,
    });
  }

  // ==========================================================================
  // Stack Management
  // ==========================================================================

  function enforceMaxHistory(): void {
    if (undoStack.length > maxHistory) {
      undoStack.splice(0, undoStack.length - maxHistory);
    }
  }

  function pushTransaction(tx: Transaction, allowMerge: boolean): void {
    const hadRedo = redoStack.length > 0;

    // Clear redo stack on new action
    if (hadRedo) {
      redoStack.length = 0;
    }

    // Try to merge with previous transaction
    if (!hadRedo && allowMerge && undoStack.length > 0) {
      const last = undoStack[undoStack.length - 1]!;
      if (canMerge(last, tx, mergeWindowMs) && mergeInto(last, tx)) {
        emit('merge', last);
        return;
      }
    }

    undoStack.push(tx);
    enforceMaxHistory();
    emit('push', tx);
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  function recordStyle(
    locator: ElementLocator,
    property: string,
    beforeValue: string,
    afterValue: string,
    recordOptions?: { merge?: boolean },
  ): Transaction | null {
    if (disposer.isDisposed) return null;

    const prop = normalizePropertyName(property);
    if (!prop) return null;

    const before = beforeValue.trim();
    const after = afterValue.trim();
    if (before === after) return null;

    const id = generateTransactionId(now());
    const tx = createStyleTransaction(id, locator, prop, before, after, now());
    pushTransaction(tx, recordOptions?.merge !== false);

    return tx;
  }

  /**
   * Record a text transaction (Phase 2.7)
   */
  function recordText(target: Element, beforeText: string, afterText: string): Transaction | null {
    if (disposer.isDisposed) return null;

    const before = String(beforeText ?? '');
    const after = String(afterText ?? '');
    if (before === after) return null;

    const locator = createElementLocator(target);
    const timestamp = now();
    const id = generateTransactionId(timestamp);
    const elementKey: WebEditorElementKey | undefined = generateStableElementKey(
      target,
      locator.shadowHostChain,
    );
    const tx = createTextTransaction(id, locator, before, after, timestamp, elementKey);

    // No merge for text transactions in Phase 2
    pushTransaction(tx, false);
    return tx;
  }

  /**
   * Record a class list change and create transaction (Phase 4.7)
   *
   * Notes:
   * - Uses setAttribute/removeAttribute for SVG compatibility
   * - Captures before/after locators to improve redo/undo recovery
   *   when CSS selectors include class-based matching
   * - No merge support (class edits should be discrete undo steps)
   */
  function recordClass(
    target: Element,
    beforeClasses: string[],
    afterClasses: string[],
  ): Transaction | null {
    if (disposer.isDisposed) return null;
    if (!target.isConnected) return null;

    // Read current DOM state as ground truth
    const domClasses = normalizeClassList(readClassList(target));
    const beforeInput = normalizeClassList(beforeClasses);
    const after = normalizeClassList(afterClasses);

    // Prefer DOM as source of truth if caller-provided classes are stale
    const before = isSameStringList(beforeInput, domClasses) ? beforeInput : domClasses;
    if (isSameStringList(before, after)) return null;

    const timestamp = now();
    const id = generateTransactionId(timestamp);

    // Capture locator before applying change (class may affect selector matching)
    const beforeLocator = createElementLocator(target);

    // Generate stable element key BEFORE class mutation to ensure consistency
    const elementKey = generateStableElementKey(target, beforeLocator.shadowHostChain);

    // Apply the change
    applyClassListToElement(target, after);

    // Capture locator after applying change
    const afterLocator = createElementLocator(target);

    const tx = createClassTransaction(
      id,
      beforeLocator,
      afterLocator,
      before,
      after,
      timestamp,
      elementKey,
    );

    // No merge for class transactions (each add/remove is a discrete undo step)
    pushTransaction(tx, false);
    return tx;
  }

  /**
   * Apply a structure operation and record a transaction (Phase 5.5)
   *
   * Performs the DOM mutation immediately and records the transaction.
   * delete/duplicate store position + html for deterministic undo/redo.
   * unwrap is limited to single-child containers to keep the schema minimal.
   */
  function applyStructure(target: Element, input: StructureOperationData): Transaction | null {
    if (disposer.isDisposed) return null;
    if (!target.isConnected) return null;
    if (isDisallowedStructureTarget(target)) return null;

    const action = input?.action;
    const timestamp = now();
    const id = generateTransactionId(timestamp);

    // =========================================================================
    // Wrap: create a container around the target element
    // =========================================================================
    if (action === 'wrap') {
      const parent = target.parentElement;
      if (!parent || !parent.isConnected || isDisallowedStructureContainer(parent)) return null;

      const beforeLocator = createElementLocator(target);
      const wrapper = wrapElementWithContainer(
        target,
        input.wrapperTag ?? 'div',
        input.wrapperStyles,
      );
      if (!wrapper || !wrapper.isConnected) return null;

      const wrapperLocator = createElementLocator(wrapper);
      const elementKey = generateStableElementKey(wrapper, wrapperLocator.shadowHostChain);
      const structureData: StructureOperationData = {
        action: 'wrap',
        wrapperTag: input.wrapperTag ?? 'div',
        wrapperStyles: input.wrapperStyles,
      };

      const tx = createStructureTransaction(
        id,
        wrapperLocator,
        beforeLocator,
        wrapperLocator,
        structureData,
        timestamp,
        elementKey,
      );

      pushTransaction(tx, false);
      return tx;
    }

    // =========================================================================
    // Unwrap: remove the container and keep its single child
    // =========================================================================
    if (action === 'unwrap') {
      const wrapper = target;
      const parent = wrapper.parentElement;
      if (!parent || !parent.isConnected || isDisallowedStructureContainer(parent)) return null;

      // Only support unwrapping containers with exactly one element child
      if (wrapper.childElementCount !== 1) return null;

      const beforeLocator = createElementLocator(wrapper);
      const wrapperTag = wrapper.tagName.toLowerCase();
      const wrapperStyles = readInlineStyleMap(wrapper);

      const child = unwrapSingleChildContainer(wrapper);
      if (!child || !child.isConnected) return null;

      const childLocator = createElementLocator(child);
      const elementKey = generateStableElementKey(child, childLocator.shadowHostChain);
      const structureData: StructureOperationData = {
        action: 'unwrap',
        wrapperTag,
        wrapperStyles,
      };

      const tx = createStructureTransaction(
        id,
        childLocator,
        beforeLocator,
        childLocator,
        structureData,
        timestamp,
        elementKey,
      );

      pushTransaction(tx, false);
      return tx;
    }

    // =========================================================================
    // Delete: remove the element and store info for restoration
    // =========================================================================
    if (action === 'delete') {
      const position = buildMoveOperationData(target);
      if (!position) return null;

      // Store outerHTML for undo restoration
      const html = String((target as unknown as { outerHTML?: unknown }).outerHTML ?? '').trim();
      if (!html) return null;

      const beforeLocator = createElementLocator(target);
      // Generate stable key BEFORE removing element from DOM
      const elementKey = generateStableElementKey(target, beforeLocator.shadowHostChain);
      const afterLocator = position.parentLocator;

      try {
        target.remove();
      } catch {
        return null;
      }

      const structureData: StructureOperationData = {
        action: 'delete',
        position,
        html,
      };

      const tx = createStructureTransaction(
        id,
        beforeLocator,
        beforeLocator,
        afterLocator,
        structureData,
        timestamp,
        elementKey,
      );

      pushTransaction(tx, false);
      return tx;
    }

    // =========================================================================
    // Duplicate: clone the element and insert after it
    // =========================================================================
    if (action === 'duplicate') {
      const parent = target.parentElement;
      if (!parent || !parent.isConnected || isDisallowedStructureContainer(parent)) return null;

      const position = buildInsertAfterPosition(target);
      if (!position) return null;

      const beforeLocator = createElementLocator(target);

      // Clone the element and strip IDs to avoid duplicates
      const clone = target.cloneNode(true) as Element;
      stripIdsFromSubtree(clone);

      try {
        // Insert immediately after target
        parent.insertBefore(clone, target.nextSibling);
      } catch {
        return null;
      }

      // Store clone's outerHTML for redo restoration
      const html = String((clone as unknown as { outerHTML?: unknown }).outerHTML ?? '').trim();
      if (!html) return null;

      const cloneLocator = createElementLocator(clone);
      // Generate key for the NEW clone element (not the original target)
      const elementKey = generateStableElementKey(clone, cloneLocator.shadowHostChain);
      const structureData: StructureOperationData = {
        action: 'duplicate',
        position,
        html,
      };

      const tx = createStructureTransaction(
        id,
        cloneLocator,
        beforeLocator,
        cloneLocator,
        structureData,
        timestamp,
        elementKey,
      );

      pushTransaction(tx, false);
      return tx;
    }

    return null;
  }

  /**
   * Begin a move transaction for drag-reorder (Phase 2.4-2.6)
   *
   * Records the element's location at drag start. Call commit() after DOM move
   * to record the final location and create the transaction.
   */
  function beginMove(target: Element): MoveTransactionHandle | null {
    if (disposer.isDisposed) return null;
    if (!target.isConnected) return null;
    if (isDisallowedMoveElement(target)) return null;

    const from = buildMoveOperationData(target);
    if (!from) return null;

    const startedAt = now();
    const id = generateTransactionId(startedAt);
    const beforeLocator = createElementLocator(target);
    let completed = false;

    function commit(targetAfterMove: Element): Transaction | null {
      if (completed || disposer.isDisposed) return null;
      completed = true;

      if (!targetAfterMove.isConnected) return null;
      if (isDisallowedMoveElement(targetAfterMove)) return null;

      const to = buildMoveOperationData(targetAfterMove);
      if (!to) return null;

      // Skip no-op moves (same parent and same effective position)
      const sameParent = locatorKey(from!.parentLocator) === locatorKey(to.parentLocator);
      const sameIndex = from!.insertIndex === to.insertIndex;
      const sameAnchorPos = from!.anchorPosition === to.anchorPosition;
      const sameAnchor =
        (!from!.anchorLocator && !to.anchorLocator) ||
        (from!.anchorLocator &&
          to.anchorLocator &&
          locatorKey(from!.anchorLocator) === locatorKey(to.anchorLocator));

      if (sameParent && sameIndex && sameAnchor && sameAnchorPos) {
        return null;
      }

      const afterLocator = createElementLocator(targetAfterMove);
      const elementKey = generateStableElementKey(targetAfterMove, afterLocator.shadowHostChain);
      const moveData: MoveTransactionData = { from: from!, to };
      const tx = createMoveTransaction(
        id,
        beforeLocator,
        afterLocator,
        moveData,
        now(),
        elementKey,
      );

      // No merge for move transactions
      pushTransaction(tx, false);
      return tx;
    }

    function cancel(): void {
      if (completed || disposer.isDisposed) return;
      completed = true;
    }

    return {
      id,
      beforeLocator,
      from,
      commit,
      cancel,
    };
  }

  function beginStyle(target: Element, property: string): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;

    const inlineStyleOrNull = getInlineStyle(target);
    if (!inlineStyleOrNull) return null;

    // Capture as non-null after guard (TypeScript can't narrow across closures)
    const inlineStyle: CSSStyleDeclaration = inlineStyleOrNull;

    const prop = normalizePropertyName(property);
    if (!prop) return null;

    const locator = createElementLocator(target);
    const beforeValue = readStyleValue(inlineStyle, prop);
    const id = generateTransactionId(now());

    // Generate stable element key at the start (before any mutations)
    const elementKey = generateStableElementKey(target, locator.shadowHostChain);

    let completed = false;

    function set(value: string): void {
      if (completed || disposer.isDisposed) return;
      writeStyleValue(inlineStyle, prop, value);
    }

    function commit(commitOptions?: { merge?: boolean }): Transaction | null {
      if (completed || disposer.isDisposed) return null;
      completed = true;

      const afterValue = readStyleValue(inlineStyle, prop);
      if (afterValue === beforeValue) return null;

      const tx = createStyleTransaction(
        id,
        locator,
        prop,
        beforeValue,
        afterValue,
        now(),
        elementKey,
      );
      pushTransaction(tx, commitOptions?.merge !== false);
      return tx;
    }

    function rollback(): void {
      if (completed || disposer.isDisposed) return;
      completed = true;

      writeStyleValue(inlineStyle, prop, beforeValue);
      emit('rollback', null);
    }

    return {
      id,
      property: prop,
      targetLocator: locator,
      set,
      commit,
      rollback,
    };
  }

  /**
   * Begin an interactive multi-style edit (Phase 4.9)
   *
   * For operations that modify multiple CSS properties atomically,
   * such as resize handles (width + height) or position handles (top + left).
   *
   * Key differences from beginStyle:
   * - Tracks multiple properties at once
   * - Only records properties that actually changed
   * - Default merge is disabled to preserve gesture undo granularity
   */
  function beginMultiStyle(
    target: Element,
    properties: string[],
  ): MultiStyleTransactionHandle | null {
    if (disposer.isDisposed) return null;

    const inlineStyleOrNull = getInlineStyle(target);
    if (!inlineStyleOrNull) return null;
    const inlineStyle: CSSStyleDeclaration = inlineStyleOrNull;

    // Normalize and deduplicate properties
    const normalizedProps = Array.from(
      new Set(
        properties.map((p) => normalizePropertyName(String(p))).filter((p): p is string => !!p),
      ),
    );
    if (normalizedProps.length === 0) return null;

    const trackedProps = new Set(normalizedProps);
    const locator = createElementLocator(target);
    const startedAt = now();
    const id = generateTransactionId(startedAt);

    // Generate stable element key at the start (before any mutations)
    const elementKey = generateStableElementKey(target, locator.shadowHostChain);

    // Capture original values for all tracked properties
    const beforeValues: Record<string, string> = {};
    for (const prop of normalizedProps) {
      beforeValues[prop] = readStyleValue(inlineStyle, prop);
    }

    let completed = false;

    /**
     * Update one or more style values (live preview).
     * Only properties declared in the initial list are applied.
     */
    function set(values: Record<string, string>): void {
      if (completed || disposer.isDisposed) return;

      for (const [rawKey, rawVal] of Object.entries(values)) {
        const prop = normalizePropertyName(rawKey);
        if (!prop || !trackedProps.has(prop)) continue;
        writeStyleValue(inlineStyle, prop, String(rawVal ?? ''));
      }
    }

    /**
     * Commit the transaction and record to history.
     * Only properties that actually changed are included in the transaction.
     */
    function commit(commitOptions?: { merge?: boolean }): Transaction | null {
      if (completed || disposer.isDisposed) return null;
      completed = true;

      const beforeStyles: Record<string, string> = {};
      const afterStyles: Record<string, string> = {};

      // Only include properties that actually changed
      for (const prop of normalizedProps) {
        const beforeVal = beforeValues[prop] ?? '';
        const afterVal = readStyleValue(inlineStyle, prop);
        if (afterVal === beforeVal) continue;
        beforeStyles[prop] = beforeVal;
        afterStyles[prop] = afterVal;
      }

      // No changes - don't create a transaction
      if (Object.keys(beforeStyles).length === 0) return null;

      const tx = createStyleTransactionFromStyles(
        id,
        locator,
        beforeStyles,
        afterStyles,
        now(),
        elementKey,
      );

      // Default to no-merge to preserve gesture undo granularity.
      // Multi-style edits (e.g., drag resize) should be single undo steps.
      pushTransaction(tx, commitOptions?.merge === true);
      return tx;
    }

    /**
     * Rollback all tracked properties to original values without recording.
     */
    function rollback(): void {
      if (completed || disposer.isDisposed) return;
      completed = true;

      for (const prop of normalizedProps) {
        writeStyleValue(inlineStyle, prop, beforeValues[prop] ?? '');
      }
      emit('rollback', null);
    }

    return {
      id,
      properties: normalizedProps,
      targetLocator: locator,
      set,
      commit,
      rollback,
    };
  }

  function applyStyle(
    target: Element,
    property: string,
    value: string,
    applyOptions?: { merge?: boolean },
  ): Transaction | null {
    const handle = beginStyle(target, property);
    if (!handle) return null;

    handle.set(value);
    return handle.commit(applyOptions);
  }

  function undo(): Transaction | null {
    if (disposer.isDisposed) return null;

    const tx = undoStack.pop();
    if (!tx) return null;

    // Try to apply the undo
    const success = applyTransaction(tx, 'undo');
    if (!success) {
      // Restore stack state on failure
      undoStack.push(tx);
      options.onApplyError?.(new Error(`Failed to locate element for undo: ${tx.id}`));
      return null;
    }

    redoStack.push(tx);
    emit('undo', tx);
    return tx;
  }

  function redo(): Transaction | null {
    if (disposer.isDisposed) return null;

    const tx = redoStack.pop();
    if (!tx) return null;

    // Try to apply the redo
    const success = applyTransaction(tx, 'redo');
    if (!success) {
      // Restore stack state on failure
      redoStack.push(tx);
      options.onApplyError?.(new Error(`Failed to locate element for redo: ${tx.id}`));
      return null;
    }

    undoStack.push(tx);
    enforceMaxHistory();
    emit('redo', tx);
    return tx;
  }

  function canUndo(): boolean {
    return undoStack.length > 0;
  }

  function canRedo(): boolean {
    return redoStack.length > 0;
  }

  function getUndoStack(): readonly Transaction[] {
    return undoStack.slice();
  }

  function getRedoStack(): readonly Transaction[] {
    return redoStack.slice();
  }

  function clear(): void {
    undoStack.length = 0;
    redoStack.length = 0;
    emit('clear', null);
  }

  // ==========================================================================
  // Keyboard Bindings
  // ==========================================================================

  if (options.enableKeyBindings) {
    disposer.listen(
      window,
      'keydown',
      (event: KeyboardEvent) => {
        // Skip if event is from editor UI
        if (options.isEventFromEditorUi?.(event)) return;

        // Check for Ctrl/Cmd modifier
        const isMod = event.metaKey || event.ctrlKey;
        if (!isMod || event.altKey) return;

        const key = event.key.toLowerCase();

        // Ctrl/Cmd+Z: Undo, Ctrl/Cmd+Shift+Z: Redo, Ctrl/Cmd+Y: Redo
        if (key === 'z') {
          if (event.shiftKey) {
            redo();
          } else {
            undo();
          }
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
        } else if (key === 'y') {
          redo();
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
        }
      },
      KEYBIND_OPTIONS,
    );
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  function dispose(): void {
    undoStack.length = 0;
    redoStack.length = 0;
    disposer.dispose();
  }

  return {
    beginStyle,
    beginMultiStyle,
    beginMove,
    applyStyle,
    recordStyle,
    recordText,
    recordClass,
    applyStructure,
    undo,
    redo,
    canUndo,
    canRedo,
    getUndoStack,
    getRedoStack,
    clear,
    dispose,
  };
}
