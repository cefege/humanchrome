/**
 * Transaction Manager — DOM helpers
 *
 * Pure DOM-level utility functions used by the transaction system:
 * - Inline style read/write
 * - Class list manipulation (SVG-compatible)
 * - Structure helpers (wrap/unwrap/insert/parse-html)
 *
 * These functions know nothing about Transactions; they only touch elements.
 */

import type { MoveOperationData } from '@/common/web-editor-types';
import { createElementLocator, locateElement } from '../locator';

// =============================================================================
// Style Helpers
// =============================================================================

/**
 * Normalize CSS property name to kebab-case.
 * Preserves custom properties (--var-name).
 */
export function normalizePropertyName(property: string): string {
  const p = property.trim();
  if (!p) return '';

  // Preserve custom properties
  if (p.startsWith('--')) return p;

  // Already kebab-case
  if (p.includes('-')) return p.toLowerCase();

  // Convert camelCase to kebab-case
  return p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`).toLowerCase();
}

/**
 * Safely get CSSStyleDeclaration from element
 */
export function getInlineStyle(element: Element): CSSStyleDeclaration | null {
  const htmlElement = element as HTMLElement;
  const style = htmlElement.style;

  if (!style) return null;
  if (typeof style.getPropertyValue !== 'function') return null;
  if (typeof style.setProperty !== 'function') return null;
  if (typeof style.removeProperty !== 'function') return null;

  return style;
}

/**
 * Read inline style property value
 */
export function readStyleValue(style: CSSStyleDeclaration, property: string): string {
  const prop = normalizePropertyName(property);
  if (!prop) return '';
  return style.getPropertyValue(prop).trim();
}

/**
 * Write inline style property value
 */
export function writeStyleValue(
  style: CSSStyleDeclaration,
  property: string,
  value: string,
): void {
  const prop = normalizePropertyName(property);
  if (!prop) return;

  const v = value.trim();
  if (!v) {
    style.removeProperty(prop);
  } else {
    style.setProperty(prop, v);
  }
}

/**
 * Apply a styles snapshot to an element
 */
export function applyStylesSnapshot(
  element: Element,
  styles: Record<string, string> | undefined,
): void {
  if (!styles) return;

  const inlineStyle = getInlineStyle(element);
  if (!inlineStyle) return;

  for (const [property, value] of Object.entries(styles)) {
    writeStyleValue(inlineStyle, property, value);
  }
}

// =============================================================================
// Class Helpers (Phase 4.7)
// =============================================================================

/**
 * Normalize class list: deduplicate, trim, remove empty tokens
 */
export function normalizeClassList(input: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of input ?? []) {
    const token = String(raw ?? '').trim();
    if (!token) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }

  return out;
}

/**
 * Check if two string arrays are equal (order-sensitive)
 */
export function isSameStringList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Read class list from element (compatible with SVG elements)
 */
export function readClassList(element: Element): string[] {
  try {
    // HTMLElement has classList, but SVG's className is SVGAnimatedString
    const list = (element as HTMLElement).classList;
    if (list && typeof list[Symbol.iterator] === 'function') {
      return Array.from(list).filter(Boolean);
    }
  } catch {
    // Fall back to attribute parsing
  }

  try {
    const raw = element.getAttribute('class') ?? '';
    return raw
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Apply class list to element (compatible with SVG elements)
 * Uses setAttribute for cross-browser SVG compatibility
 */
export function applyClassListToElement(element: Element, classes: readonly string[]): void {
  const normalized = normalizeClassList(classes);
  const value = normalized.join(' ').trim();

  try {
    if (value) {
      element.setAttribute('class', value);
    } else {
      element.removeAttribute('class');
    }
  } catch {
    // Best-effort: element may be in an invalid state or disconnected
  }
}

// =============================================================================
// Structure Helpers (Phase 5.5)
// =============================================================================

/**
 * Read element's inline styles as a plain object.
 * Only includes explicitly set inline properties (not computed styles).
 */
export function readInlineStyleMap(element: Element): Record<string, string> | undefined {
  const style = getInlineStyle(element);
  if (!style) return undefined;

  const result: Record<string, string> = {};
  for (let i = 0; i < style.length; i++) {
    const prop = style.item(i);
    if (!prop) continue;
    const value = style.getPropertyValue(prop).trim();
    if (value) {
      result[prop] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Parse HTML string into a single root element.
 * Returns null if parsing fails or yields multiple root elements.
 */
export function parseSingleRootElement(html: string): Element | null {
  const trimmed = String(html ?? '').trim();
  if (!trimmed) return null;

  try {
    const template = document.createElement('template');
    template.innerHTML = trimmed;

    const firstChild = template.content.firstElementChild;
    if (!firstChild || template.content.childElementCount !== 1) {
      return null;
    }
    return firstChild;
  } catch {
    return null;
  }
}

/**
 * Remove id attributes from an element and all its descendants.
 * Used by duplicate to avoid creating duplicate IDs on the page.
 */
export function stripIdsFromSubtree(root: Element): void {
  try {
    root.removeAttribute('id');
    const descendantsWithId = root.querySelectorAll('[id]');
    for (const el of Array.from(descendantsWithId)) {
      el.removeAttribute('id');
    }
  } catch {
    // Best-effort: ignore errors
  }
}

/**
 * Insert an element into a parent at a specific position.
 * Used for deterministic undo/redo of delete/duplicate operations.
 */
export function insertElementAtPosition(
  parent: Element,
  element: Element,
  position: MoveOperationData,
): boolean {
  if (!parent.isConnected) return false;

  let reference: ChildNode | null = null;

  // Anchor-first resolution for stability
  if (position.anchorLocator) {
    const anchor = locateElement(position.anchorLocator);
    if (anchor && anchor.parentElement === parent) {
      reference = position.anchorPosition === 'before' ? anchor : anchor.nextSibling;
    }
  }

  // Fallback to index-based insertion
  if (!reference) {
    const children = Array.from(parent.children);
    const index = Math.max(0, Math.min(position.insertIndex, children.length));
    reference = children[index] ?? null;
  }

  try {
    parent.insertBefore(element, reference);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wrap an element with a new container at the same DOM position.
 * Returns the wrapper element on success, null on failure.
 */
export function wrapElementWithContainer(
  target: Element,
  wrapperTag: string,
  wrapperStyles?: Record<string, string>,
): Element | null {
  const parent = target.parentElement;
  if (!parent) return null;

  const tag = String(wrapperTag || 'div').toLowerCase();
  const wrapper = document.createElement(tag);

  // Apply wrapper styles
  if (wrapperStyles) {
    applyStylesSnapshot(wrapper, wrapperStyles);
  }

  try {
    parent.insertBefore(wrapper, target);
    wrapper.appendChild(target);
    return wrapper;
  } catch {
    return null;
  }
}

/**
 * Unwrap a container that has exactly one element child.
 * Moves the child to the container's position and removes the container.
 * Returns the unwrapped child on success, null on failure.
 */
export function unwrapSingleChildContainer(wrapper: Element): Element | null {
  const parent = wrapper.parentElement;
  if (!parent) return null;
  if (wrapper.childElementCount !== 1) return null;

  const child = wrapper.firstElementChild;
  if (!child) return null;

  try {
    parent.insertBefore(child, wrapper);
    wrapper.remove();
    return child;
  } catch {
    return null;
  }
}

/**
 * Build insertion position data for inserting after a target element.
 * Used by duplicate to record where the clone was inserted.
 */
export function buildInsertAfterPosition(target: Element): MoveOperationData | null {
  const parent = target.parentElement;
  if (!parent) return null;

  const siblings = Array.from(parent.children);
  const index = siblings.indexOf(target);
  if (index < 0) return null;

  return {
    parentLocator: createElementLocator(parent),
    insertIndex: index + 1,
    anchorLocator: createElementLocator(target),
    anchorPosition: 'after',
  };
}
