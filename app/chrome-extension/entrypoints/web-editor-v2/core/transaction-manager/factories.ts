/**
 * Transaction Manager — Transaction factories
 *
 * Pure functions that build Transaction records from input data.
 * Also includes pre-flight checks (disallowed targets) and the helper
 * that snapshots an element's current DOM position into MoveOperationData.
 */

import type {
  ElementLocator,
  MoveOperationData,
  MoveTransactionData,
  StructureOperationData,
  Transaction,
  TransactionSnapshot,
  WebEditorElementKey,
} from '@/common/web-editor-types';
import { createElementLocator } from '../locator';
import { normalizePropertyName } from './dom-helpers';

// =============================================================================
// Transaction ID generation
// =============================================================================

let transactionSeq = 0;

/**
 * Generate unique transaction ID
 */
export function generateTransactionId(timestamp: number): string {
  transactionSeq += 1;
  return `tx_${timestamp.toString(36)}_${transactionSeq.toString(36)}`;
}

// =============================================================================
// Transaction factories
// =============================================================================

/**
 * Create a style transaction record from style maps.
 * This is the core factory used by both single-style and multi-style APIs.
 *
 * @param id - Unique transaction identifier
 * @param locator - Target element locator
 * @param beforeStyles - Style values before the change
 * @param afterStyles - Style values after the change
 * @param timestamp - Transaction timestamp
 * @param elementKey - Optional stable element key for transaction grouping
 */
export function createStyleTransactionFromStyles(
  id: string,
  locator: ElementLocator,
  beforeStyles: Record<string, string>,
  afterStyles: Record<string, string>,
  timestamp: number,
  elementKey?: WebEditorElementKey,
): Transaction {
  const beforeSnapshot: TransactionSnapshot = {
    locator,
    styles: beforeStyles,
  };

  const afterSnapshot: TransactionSnapshot = {
    locator,
    styles: afterStyles,
  };

  return {
    id,
    type: 'style',
    targetLocator: locator,
    elementKey,
    before: beforeSnapshot,
    after: afterSnapshot,
    timestamp,
    merged: false,
  };
}

/**
 * Create a style transaction record for a single property.
 * Convenience wrapper around createStyleTransactionFromStyles.
 */
export function createStyleTransaction(
  id: string,
  locator: ElementLocator,
  property: string,
  beforeValue: string,
  afterValue: string,
  timestamp: number,
  elementKey?: WebEditorElementKey,
): Transaction {
  const prop = normalizePropertyName(property);
  return createStyleTransactionFromStyles(
    id,
    locator,
    { [prop]: beforeValue },
    { [prop]: afterValue },
    timestamp,
    elementKey,
  );
}

/**
 * Create a text transaction record (Phase 2.7)
 */
export function createTextTransaction(
  id: string,
  locator: ElementLocator,
  beforeText: string,
  afterText: string,
  timestamp: number,
  elementKey?: WebEditorElementKey,
): Transaction {
  const beforeSnapshot: TransactionSnapshot = {
    locator,
    text: beforeText,
  };

  const afterSnapshot: TransactionSnapshot = {
    locator,
    text: afterText,
  };

  return {
    id,
    type: 'text',
    targetLocator: locator,
    elementKey,
    before: beforeSnapshot,
    after: afterSnapshot,
    timestamp,
    merged: false,
  };
}

/**
 * Create a class transaction record (Phase 4.7)
 *
 * Uses separate before/after locators to improve undo/redo recovery
 * when CSS selectors include class-based matching.
 */
export function createClassTransaction(
  id: string,
  beforeLocator: ElementLocator,
  afterLocator: ElementLocator,
  beforeClasses: string[],
  afterClasses: string[],
  timestamp: number,
  elementKey?: WebEditorElementKey,
): Transaction {
  const beforeSnapshot: TransactionSnapshot = {
    locator: beforeLocator,
    classes: beforeClasses,
  };

  const afterSnapshot: TransactionSnapshot = {
    locator: afterLocator,
    classes: afterClasses,
  };

  return {
    id,
    type: 'class',
    targetLocator: afterLocator,
    elementKey,
    before: beforeSnapshot,
    after: afterSnapshot,
    timestamp,
    merged: false,
  };
}

/**
 * Create a move transaction record (Phase 2.4-2.6)
 */
export function createMoveTransaction(
  id: string,
  beforeLocator: ElementLocator,
  afterLocator: ElementLocator,
  moveData: MoveTransactionData,
  timestamp: number,
  elementKey?: WebEditorElementKey,
): Transaction {
  const beforeSnapshot: TransactionSnapshot = {
    locator: beforeLocator,
  };

  const afterSnapshot: TransactionSnapshot = {
    locator: afterLocator,
  };

  return {
    id,
    type: 'move',
    targetLocator: afterLocator,
    elementKey,
    before: beforeSnapshot,
    after: afterSnapshot,
    moveData,
    timestamp,
    merged: false,
  };
}

/**
 * Create a structure transaction record (Phase 5.5)
 *
 * Used for wrap/unwrap/delete/duplicate operations.
 * delete/duplicate store position + html for deterministic undo/redo.
 */
export function createStructureTransaction(
  id: string,
  targetLocator: ElementLocator,
  beforeLocator: ElementLocator,
  afterLocator: ElementLocator,
  structureData: StructureOperationData,
  timestamp: number,
  elementKey?: WebEditorElementKey,
): Transaction {
  const beforeSnapshot: TransactionSnapshot = { locator: beforeLocator };
  const afterSnapshot: TransactionSnapshot = { locator: afterLocator };

  return {
    id,
    type: 'structure',
    targetLocator,
    elementKey,
    before: beforeSnapshot,
    after: afterSnapshot,
    structureData,
    timestamp,
    merged: false,
  };
}

// =============================================================================
// Target validation
// =============================================================================

/**
 * Check if element is a disallowed target for structure operations (HTML/BODY/HEAD)
 * These elements should not be wrapped, deleted, duplicated, or unwrapped.
 */
export function isDisallowedStructureTarget(element: Element): boolean {
  const tag = element.tagName?.toUpperCase();
  return tag === 'HTML' || tag === 'BODY' || tag === 'HEAD';
}

/**
 * Check if element is a disallowed parent container for structure operations (HTML/HEAD only)
 * BODY is allowed as a parent container (unlike as a target).
 */
export function isDisallowedStructureContainer(element: Element): boolean {
  const tag = element.tagName?.toUpperCase();
  return tag === 'HTML' || tag === 'HEAD';
}

/**
 * Check if element is a disallowed move target (HTML/BODY/HEAD)
 */
export function isDisallowedMoveElement(element: Element): boolean {
  const tag = element.tagName?.toUpperCase();
  return tag === 'HTML' || tag === 'BODY' || tag === 'HEAD';
}

// =============================================================================
// Move position snapshot
// =============================================================================

/**
 * Build MoveOperationData from element's current DOM position
 */
export function buildMoveOperationData(element: Element): MoveOperationData | null {
  const parent = element.parentElement;
  if (!parent) return null;

  const siblings = Array.from(parent.children);
  const insertIndex = siblings.indexOf(element);
  if (insertIndex < 0) return null;

  const parentLocator = createElementLocator(parent);

  // Prefer anchoring to next sibling (insertBefore semantics)
  const next = element.nextElementSibling;
  if (next) {
    return {
      parentLocator,
      insertIndex,
      anchorLocator: createElementLocator(next),
      anchorPosition: 'before',
    };
  }

  // Fallback to previous sibling
  const prev = element.previousElementSibling;
  if (prev) {
    return {
      parentLocator,
      insertIndex,
      anchorLocator: createElementLocator(prev),
      anchorPosition: 'after',
    };
  }

  // No siblings - index only
  return {
    parentLocator,
    insertIndex,
    anchorPosition: 'before',
  };
}
