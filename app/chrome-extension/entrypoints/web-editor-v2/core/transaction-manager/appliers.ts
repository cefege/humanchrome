/**
 * Transaction Manager — Transaction appliers
 *
 * Pure functions that apply a Transaction to the live DOM, in either
 * undo or redo direction. Also includes the merge predicates that the
 * manager uses to decide whether consecutive style edits should fold
 * into a single undo step.
 */

import type { MoveOperationData, Transaction } from '@/common/web-editor-types';
import { createElementLocator, locateElement, locatorKey } from '../locator';
import {
  applyClassListToElement,
  applyStylesSnapshot,
  insertElementAtPosition,
  parseSingleRootElement,
  unwrapSingleChildContainer,
  wrapElementWithContainer,
} from './dom-helpers';
import {
  isDisallowedMoveElement,
  isDisallowedStructureContainer,
  isDisallowedStructureTarget,
} from './factories';

// =============================================================================
// Move application
// =============================================================================

/**
 * Apply a move operation (for undo/redo)
 */
export function applyMoveOperation(target: Element, op: MoveOperationData): boolean {
  if (!target.isConnected) return false;
  if (isDisallowedMoveElement(target)) return false;

  const parent = locateElement(op.parentLocator);
  if (!parent) return false;
  if (!parent.isConnected) return false;

  // Disallow cross-root moves
  const targetRoot = target.getRootNode?.();
  const parentRoot = parent.getRootNode?.();
  if (targetRoot && parentRoot && targetRoot !== parentRoot) return false;

  // Prevent cycles (moving into own descendant)
  if (target === parent || target.contains(parent)) return false;

  let reference: ChildNode | null = null;

  // Anchor-first resolution
  if (op.anchorLocator) {
    const anchor = locateElement(op.anchorLocator);
    if (anchor && anchor !== target && anchor.parentElement === parent) {
      reference = op.anchorPosition === 'before' ? anchor : anchor.nextSibling;
      // Skip if reference is the target itself
      if (reference === target) {
        reference = target.nextSibling;
      }
    }
  }

  // Fallback: index-based
  if (!reference) {
    const children = Array.from(parent.children);
    // Remove target from consideration if it's already in parent
    const existingIndex = children.indexOf(target);
    if (existingIndex !== -1) {
      children.splice(existingIndex, 1);
    }
    const index = Math.max(0, Math.min(op.insertIndex, children.length));
    reference = children[index] ?? null;
  }

  try {
    parent.insertBefore(target, reference);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Style transaction merging
// =============================================================================

/**
 * Get the single style property from a transaction (if applicable)
 */
export function getSingleStyleProperty(tx: Transaction): string | null {
  const keys = new Set<string>();

  if (tx.before.styles) {
    for (const k of Object.keys(tx.before.styles)) keys.add(k);
  }
  if (tx.after.styles) {
    for (const k of Object.keys(tx.after.styles)) keys.add(k);
  }

  return keys.size === 1 ? Array.from(keys)[0]! : null;
}

/**
 * Check if two transactions can be merged
 */
export function canMerge(prev: Transaction, next: Transaction, mergeWindowMs: number): boolean {
  // Only merge style transactions
  if (prev.type !== 'style' || next.type !== 'style') return false;

  // Check time window
  if (Math.abs(next.timestamp - prev.timestamp) > mergeWindowMs) return false;

  // Check same target element
  if (locatorKey(prev.targetLocator) !== locatorKey(next.targetLocator)) return false;

  // Check same property
  const prevProp = getSingleStyleProperty(prev);
  const nextProp = getSingleStyleProperty(next);
  if (!prevProp || !nextProp || prevProp !== nextProp) return false;

  return true;
}

/**
 * Merge next transaction into prev (mutates prev)
 */
export function mergeInto(prev: Transaction, next: Transaction): boolean {
  const prop = getSingleStyleProperty(prev);
  if (!prop) return false;

  const nextValue = next.after.styles?.[prop];
  if (nextValue === undefined) return false;

  // Update prev's after state
  if (!prev.after.styles) prev.after.styles = {};
  prev.after.styles[prop] = nextValue;
  prev.timestamp = next.timestamp;
  prev.merged = true;

  return true;
}

// =============================================================================
// Structure transaction application
// =============================================================================

/**
 * Apply a structure transaction (undo or redo) - Phase 5.5
 *
 * Structure operations may create/remove nodes, so delete/duplicate
 * store position + html to make redo/undo deterministic.
 */
export function applyStructureTransaction(
  tx: Transaction,
  direction: 'undo' | 'redo',
): boolean {
  const data = tx.structureData;
  if (!data) return false;

  const isRedo = direction === 'redo';

  switch (data.action) {
    case 'wrap': {
      if (isRedo) {
        // Redo wrap: find the target and wrap it
        const target =
          locateElement(tx.before.locator) ??
          locateElement(tx.targetLocator) ??
          locateElement(tx.after.locator);
        if (!target || !target.isConnected) return false;
        if (isDisallowedStructureTarget(target)) return false;

        const parent = target.parentElement;
        if (!parent || !parent.isConnected || isDisallowedStructureContainer(parent)) return false;

        const wrapper = wrapElementWithContainer(
          target,
          data.wrapperTag ?? 'div',
          data.wrapperStyles,
        );
        if (!wrapper || !wrapper.isConnected) return false;

        // Update locators for subsequent undo
        const wrapperLocator = createElementLocator(wrapper);
        tx.after.locator = wrapperLocator;
        tx.targetLocator = wrapperLocator;
        return true;
      }

      // Undo wrap: unwrap the wrapper
      const wrapper = locateElement(tx.after.locator) ?? locateElement(tx.targetLocator);
      if (!wrapper || !wrapper.isConnected) return false;
      if (isDisallowedStructureTarget(wrapper)) return false;

      const child = unwrapSingleChildContainer(wrapper);
      if (!child || !child.isConnected) return false;

      // Update before locator for subsequent redo
      tx.before.locator = createElementLocator(child);
      return true;
    }

    case 'unwrap': {
      if (isRedo) {
        // Redo unwrap: find the wrapper and unwrap it
        const wrapper =
          locateElement(tx.before.locator) ??
          locateElement(tx.after.locator)?.parentElement ??
          locateElement(tx.targetLocator)?.parentElement;
        if (!wrapper || !wrapper.isConnected) return false;
        if (isDisallowedStructureTarget(wrapper)) return false;

        const child = unwrapSingleChildContainer(wrapper);
        if (!child || !child.isConnected) return false;

        // Update locators for subsequent undo
        const childLocator = createElementLocator(child);
        tx.after.locator = childLocator;
        tx.targetLocator = childLocator;
        return true;
      }

      // Undo unwrap: rewrap the child
      const child = locateElement(tx.after.locator) ?? locateElement(tx.targetLocator);
      if (!child || !child.isConnected) return false;
      if (isDisallowedStructureTarget(child)) return false;

      const parent = child.parentElement;
      if (!parent || !parent.isConnected || isDisallowedStructureContainer(parent)) return false;

      const wrapper = wrapElementWithContainer(
        child,
        data.wrapperTag ?? 'div',
        data.wrapperStyles,
      );
      if (!wrapper || !wrapper.isConnected) return false;

      // Update before locator for subsequent redo
      tx.before.locator = createElementLocator(wrapper);
      return true;
    }

    case 'delete': {
      if (isRedo) {
        // Redo delete: remove the element
        const target = locateElement(tx.before.locator) ?? locateElement(tx.targetLocator);
        if (!target || !target.isConnected) return false;
        if (isDisallowedStructureTarget(target)) return false;

        target.remove();
        return true;
      }

      // Undo delete: restore the element from html + position
      if (!data.position || !data.html) return false;

      const parent = locateElement(data.position.parentLocator);
      if (!parent || !parent.isConnected || isDisallowedStructureContainer(parent)) return false;

      const element = parseSingleRootElement(data.html);
      if (!element) return false;

      if (!insertElementAtPosition(parent, element, data.position)) return false;

      // Update locators for subsequent redo
      const locator = createElementLocator(element);
      tx.before.locator = locator;
      tx.targetLocator = locator;
      return true;
    }

    case 'duplicate': {
      if (isRedo) {
        // Redo duplicate: recreate the clone from html + position
        if (!data.position || !data.html) return false;

        const parent = locateElement(data.position.parentLocator);
        if (!parent || !parent.isConnected || isDisallowedStructureContainer(parent)) return false;

        const element = parseSingleRootElement(data.html);
        if (!element) return false;

        if (!insertElementAtPosition(parent, element, data.position)) return false;

        // Update locators for subsequent undo
        const locator = createElementLocator(element);
        tx.after.locator = locator;
        tx.targetLocator = locator;
        return true;
      }

      // Undo duplicate: remove the clone
      const clone = locateElement(tx.after.locator) ?? locateElement(tx.targetLocator);
      if (!clone || !clone.isConnected) return false;
      if (isDisallowedStructureTarget(clone)) return false;

      clone.remove();
      return true;
    }

    default:
      return false;
  }
}

// =============================================================================
// Top-level transaction dispatcher
// =============================================================================

/**
 * Apply a transaction (undo or redo)
 * Returns true on success, false on failure
 */
export function applyTransaction(tx: Transaction, direction: 'undo' | 'redo'): boolean {
  // Phase 2.4-2.6: Apply move transactions
  if (tx.type === 'move') {
    const moveData = tx.moveData;
    if (!moveData) return false;

    // For undo: element is currently at after position, use after.locator to find it
    // For redo: element is currently at before position, use before.locator to find it
    const primaryLocator = direction === 'undo' ? tx.after.locator : tx.before.locator;
    const fallbackLocator = direction === 'undo' ? tx.before.locator : tx.after.locator;

    const target =
      locateElement(primaryLocator) ??
      locateElement(fallbackLocator) ??
      locateElement(tx.targetLocator);

    if (!target) return false;

    const op = direction === 'undo' ? moveData.from : moveData.to;
    return applyMoveOperation(target, op);
  }

  // Phase 4.7: Apply class transactions
  if (tx.type === 'class') {
    // For undo: element is currently at after state, use after.locator to find it
    // For redo: element is currently at before state, use before.locator to find it
    const primaryLocator = direction === 'undo' ? tx.after.locator : tx.before.locator;
    const fallbackLocator = direction === 'undo' ? tx.before.locator : tx.after.locator;

    const target =
      locateElement(primaryLocator) ??
      locateElement(fallbackLocator) ??
      locateElement(tx.targetLocator);

    if (!target) return false;

    const snapshot = direction === 'undo' ? tx.before : tx.after;
    const classes = Array.isArray(snapshot.classes) ? snapshot.classes : [];
    applyClassListToElement(target, classes);
    return true;
  }

  // Phase 5.5: Apply structure transactions
  if (tx.type === 'structure') {
    return applyStructureTransaction(tx, direction);
  }

  // Only handle style and text transactions (other types are no-op here)
  if (tx.type !== 'style' && tx.type !== 'text') return true;

  const target = locateElement(tx.targetLocator);
  if (!target) {
    return false;
  }

  const snapshot = direction === 'undo' ? tx.before : tx.after;

  if (tx.type === 'style') {
    applyStylesSnapshot(target, snapshot.styles);
    return true;
  }

  // Phase 2.7: Apply text content change
  if (tx.type === 'text') {
    target.textContent = snapshot.text ?? '';
    return true;
  }

  return true;
}
