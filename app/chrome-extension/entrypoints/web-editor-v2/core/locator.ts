/**
 * Element Locator Utilities
 *
 * Generates and resolves CSS-based element locators for the Transaction System.
 *
 * Design goals:
 * - Generate stable, unique CSS selectors for DOM elements
 * - Support Shadow DOM boundaries with host chain traversal
 * - Provide fallback strategies when primary selector fails
 * - Compute structural fingerprints for fuzzy matching
 */

import type { ElementLocator } from '@/common/web-editor-types';
import { selectorPolicy } from 'humanchrome-shared';
import {
  computeDomPath,
  computeFingerprint,
  cssEscape,
  verifyFingerprint,
} from '@/shared/selector';
import { findDebugSource } from './debug-source';

export { computeDomPath, computeFingerprint };

// =============================================================================
// Types
// =============================================================================

/** Options for CSS selector generation */
export interface SelectorGenerationOptions {
  /** Root node for uniqueness checking (defaults to element's root) */
  root?: Document | ShadowRoot;
  /** Maximum number of selector candidates to generate */
  maxCandidates?: number;
}

// DOM candidate construction and uniqueness checks stay in this adapter. The
// Rust policy kernel supplies their attribute lists, collection limits, and
// final head/path/anchor selection plan.

// =============================================================================
// Query Helpers
// =============================================================================

/**
 * Get the query root for an element (Document or ShadowRoot)
 */
function getQueryRoot(element: Element): Document | ShadowRoot {
  const root = element.getRootNode?.();
  return root instanceof ShadowRoot ? root : document;
}

/**
 * Safely execute querySelector, returning null on invalid selectors
 */
function safeQuerySelector(root: ParentNode, selector: string): Element | null {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

/**
 * Check if a selector matches exactly one element in the root
 */
function isUnique(root: ParentNode, selector: string): boolean {
  try {
    return root.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

// =============================================================================
// Selector Generation Strategies
// =============================================================================

/**
 * Try to build a unique ID-based selector
 */
function tryIdSelector(element: Element, root: ParentNode): string | null {
  const id = element.id?.trim();
  if (!id) return null;

  const selector = `#${cssEscape(id)}`;
  return isUnique(root, selector) ? selector : null;
}

/**
 * Collect unique data-attribute selector candidates in Rust-provided order.
 */
function collectDataAttrSelectors(
  element: Element,
  root: ParentNode,
  max: number,
  attributes: readonly string[],
): string[] {
  const out: string[] = [];
  if (max <= 0) return out;

  const tag = element.tagName.toLowerCase();

  for (const attr of attributes) {
    if (out.length >= max) break;
    const value = element.getAttribute(attr)?.trim();
    if (!value) continue;

    const attrOnly = `[${attr}="${cssEscape(value)}"]`;
    if (isUnique(root, attrOnly)) {
      out.push(attrOnly);
      continue;
    }

    const withTag = `${tag}${attrOnly}`;
    if (isUnique(root, withTag)) {
      out.push(withTag);
    }
  }

  return out;
}

/**
 * Collect unique class-based selector candidates from Rust-filtered class indexes.
 */
function collectClassSelectors(
  element: Element,
  root: ParentNode,
  max: number,
  maxComboDepth: number,
): string[] {
  const out: string[] = [];
  if (max <= 0) return out;

  const tag = element.tagName.toLowerCase();
  const rawClasses = Array.from(element.classList);
  const classes = selectorPolicy
    .rustEditorLocatorClassIndexes(rawClasses)
    .map((index) => rawClasses[index]!);

  if (classes.length === 0) return out;

  const uniqueSingle = new Map<string, boolean>();

  for (const cls of classes) {
    if (out.length >= max) return out;
    const sel = `.${cssEscape(cls)}`;
    const unique = isUnique(root, sel);
    uniqueSingle.set(cls, unique);
    if (unique) out.push(sel);
  }

  for (const cls of classes) {
    if (out.length >= max) return out;
    if (uniqueSingle.get(cls) === true) continue;
    const sel = `${tag}.${cssEscape(cls)}`;
    if (isUnique(root, sel)) out.push(sel);
  }

  const limit = Math.min(classes.length, maxComboDepth);
  for (let i = 0; i < limit; i++) {
    for (let j = i + 1; j < limit; j++) {
      if (out.length >= max) return out;
      const a = classes[i]!;
      const b = classes[j]!;
      const pair = `.${cssEscape(a)}.${cssEscape(b)}`;
      if (isUnique(root, pair)) {
        out.push(pair);
        continue;
      }
      const withTag = `${tag}${pair}`;
      if (isUnique(root, withTag)) out.push(withTag);
    }
  }

  if (limit >= 3 && out.length < max) {
    const triple = `.${cssEscape(classes[0]!)}.${cssEscape(classes[1]!)}.${cssEscape(classes[2]!)}`;
    if (isUnique(root, triple)) {
      out.push(triple);
    } else {
      const withTag = `${tag}${triple}`;
      if (out.length < max && isUnique(root, withTag)) out.push(withTag);
    }
  }

  return out;
}

/**
 * Build a structural path selector using nth-of-type
 */
function buildPathSelector(element: Element, root: Document | ShadowRoot): string {
  const segments: string[] = [];
  let current: Element | null = element;

  // Determine stop condition based on root type
  const isDocument = root instanceof Document;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const tag = current.tagName.toLowerCase();

    // Stop at body for document, or at shadow root boundary
    if (isDocument && tag === 'body') break;

    let selector = tag;

    // Find parent context
    const parent: Element | null = current.parentElement;
    const parentNode = current.parentNode;

    // Get siblings from appropriate parent
    let siblings: Element[];
    if (parent) {
      siblings = Array.from(parent.children);
    } else if (parentNode instanceof ShadowRoot || parentNode instanceof Document) {
      siblings = Array.from(parentNode.children);
    } else {
      siblings = [];
    }

    // Add nth-of-type if there are siblings with same tag
    const sameTagSiblings = siblings.filter((s) => s.tagName === current!.tagName);
    if (sameTagSiblings.length > 1) {
      const index = sameTagSiblings.indexOf(current) + 1;
      selector += `:nth-of-type(${index})`;
    }

    segments.unshift(selector);
    current = parent;

    // Stop if we've reached the root's direct children
    if (!parent && parentNode === root) break;
  }

  const path = segments.join(' > ');
  return isDocument ? `body > ${path}` : path || '*';
}

// =============================================================================
// Anchor + Relative Path (Phase 2.9)
// =============================================================================

/**
 * Build a relative path selector from an ancestor to a target within the same root.
 */
function buildRelativePathSelector(
  ancestor: Element,
  target: Element,
  root: Document | ShadowRoot,
  maxAnchorDepth: number,
): string | null {
  const segments: string[] = [];
  let current: Element | null = target;

  for (let depth = 0; current && current !== ancestor && depth < maxAnchorDepth; depth++) {
    const tag = current.tagName.toLowerCase();
    let selector = tag;

    const parent: Element | null = current.parentElement;
    const parentNode = current.parentNode;

    let siblings: Element[];
    if (parent) {
      siblings = Array.from(parent.children);
    } else if (parentNode instanceof ShadowRoot || parentNode instanceof Document) {
      siblings = Array.from(parentNode.children);
    } else {
      siblings = [];
    }

    const sameTagSiblings = siblings.filter((s) => s.tagName === current!.tagName);
    if (sameTagSiblings.length > 1) {
      const index = sameTagSiblings.indexOf(current) + 1;
      selector += `:nth-of-type(${index})`;
    }

    segments.unshift(selector);

    if (!parent) {
      // Reached the root boundary without finding the ancestor
      if (parentNode === root) break;
      break;
    }

    current = parent;
  }

  if (current !== ancestor) return null;
  return segments.join(' > ') || null;
}

/**
 * Try to build a unique anchor selector for an ancestor (id or stable data-* only).
 */
function tryAnchorSelector(
  element: Element,
  root: ParentNode,
  attributes: readonly string[],
): string | null {
  const idSel = tryIdSelector(element, root);
  if (idSel) return idSel;

  const tag = element.tagName.toLowerCase();

  for (const attr of attributes) {
    const value = element.getAttribute(attr)?.trim();
    if (!value) continue;

    const attrOnly = `[${attr}="${cssEscape(value)}"]`;
    if (isUnique(root, attrOnly)) return attrOnly;

    const withTag = `${tag}${attrOnly}`;
    if (isUnique(root, withTag)) return withTag;
  }

  return null;
}

/**
 * Build an "anchor + relative path" selector candidate.
 * Finds a unique ancestor (id or stable data-*) and appends a relative path from there.
 * This improves matching when the target itself doesn't have unique attributes.
 */
function buildAnchorRelPathSelector(
  element: Element,
  root: Document | ShadowRoot,
  attributes: readonly string[],
  maxAnchorDepth: number,
): string | null {
  let current: Element | null = element.parentElement;

  for (let depth = 0; current && depth < maxAnchorDepth; depth++) {
    const tag = current.tagName.toUpperCase();
    if (tag === 'HTML' || tag === 'BODY') break;

    const anchor = tryAnchorSelector(current, root, attributes);
    if (anchor) {
      const rel = buildRelativePathSelector(current, element, root, maxAnchorDepth);
      if (!rel) {
        current = current.parentElement;
        continue;
      }

      const composed = `${anchor} ${rel}`;
      if (!isUnique(root, composed)) {
        current = current.parentElement;
        continue;
      }

      // Final verification: ensure the composed selector finds the exact element
      const found = safeQuerySelector(root, composed);
      if (found === element) return composed;
    }

    current = current.parentElement;
  }

  return null;
}

// =============================================================================
// Shadow DOM Utilities
// =============================================================================

/**
 * Get selector chain for shadow host ancestors (from outer to inner)
 */
export function getShadowHostChain(element: Element): string[] | undefined {
  const chain: string[] = [];
  let current: Element = element;

  while (true) {
    const root = current.getRootNode?.();
    if (!(root instanceof ShadowRoot)) break;

    const host = root.host;
    if (!(host instanceof Element)) break;

    const hostRoot = getQueryRoot(host);
    const hostSelector = generateCssSelector(host, { root: hostRoot });
    if (!hostSelector) break;

    chain.unshift(hostSelector);
    current = host;
  }

  return chain.length > 0 ? chain : undefined;
}


// =============================================================================
// Public API - Selector Generation
// =============================================================================

/**
 * Generate multiple CSS selector candidates for an element.
 *
 * The DOM adapter collects unique id/data/class/path/anchor observations. Rust
 * owns their priority, fallback reservation, truncation, and final selection.
 */
export function generateSelectorCandidates(
  element: Element,
  options: SelectorGenerationOptions = {},
): string[] {
  const root = options.root ?? getQueryRoot(element);
  const collectionPlan = selectorPolicy.rustEditorLocatorPlan(options.maxCandidates);
  const anchorCandidate = collectionPlan.collectAnchor
    ? buildAnchorRelPathSelector(
        element,
        root,
        collectionPlan.anchorAttributes,
        collectionPlan.maxAnchorDepth,
      )
    : null;
  const selectionPlan = selectorPolicy.rustEditorLocatorPlan(
    options.maxCandidates,
    anchorCandidate !== null,
  );
  const headCandidates: string[] = [];

  const idSelector = tryIdSelector(element, root);
  if (idSelector) headCandidates.push(idSelector);

  headCandidates.push(
    ...collectDataAttrSelectors(
      element,
      root,
      selectionPlan.headLimit - headCandidates.length,
      selectionPlan.dataAttributes,
    ),
  );
  headCandidates.push(
    ...collectClassSelectors(
      element,
      root,
      selectionPlan.headLimit - headCandidates.length,
      selectionPlan.maxClassComboDepth,
    ),
  );

  return selectorPolicy.selectRustEditorLocatorCandidates(
    headCandidates,
    buildPathSelector(element, root),
    anchorCandidate,
    options.maxCandidates,
  );
}

/**
 * Generate a single best CSS selector for an element
 */
export function generateCssSelector(
  element: Element,
  options: SelectorGenerationOptions = {},
): string {
  return generateSelectorCandidates(element, options)[0] ?? '';
}

// =============================================================================
// Public API - Locator Creation & Resolution
// =============================================================================

/**
 * Create a complete ElementLocator for an element.
 * The locator contains multiple strategies for re-identification.
 */
export function createElementLocator(element: Element): ElementLocator {
  const root = getQueryRoot(element);

  // Extract debug source (React/Vue component file path)
  // This is best-effort and returns undefined if not available
  const debugSource = findDebugSource(element) ?? undefined;

  return {
    selectors: generateSelectorCandidates(element, { root }),
    fingerprint: computeFingerprint(element),
    path: computeDomPath(element),
    shadowHostChain: getShadowHostChain(element),
    debugSource,
  };
}

/**
 * Safely check if a selector matches exactly one element
 */
function isSelectorUnique(root: ParentNode, selector: string): boolean {
  try {
    return root.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}


/**
 * Resolve an ElementLocator to a DOM element.
 * Traverses Shadow DOM boundaries and tries multiple selector candidates.
 * Includes uniqueness verification to avoid misidentification.
 */
export function locateElement(
  locator: ElementLocator,
  rootDocument: Document = document,
): Element | null {
  let doc: Document = rootDocument;

  // Traverse iframe chain (Phase 4 - not implemented yet)
  if (locator.frameChain?.length) {
    for (const frameSelector of locator.frameChain) {
      const frame = safeQuerySelector(doc, frameSelector);
      if (!(frame instanceof HTMLIFrameElement)) return null;
      const contentDoc = frame.contentDocument;
      if (!contentDoc) return null;
      doc = contentDoc;
    }
  }

  // Start with document as query root
  let queryRoot: Document | ShadowRoot = doc;

  // Traverse Shadow DOM host chain
  if (locator.shadowHostChain?.length) {
    for (const hostSelector of locator.shadowHostChain) {
      // Verify host selector is unique
      if (!isSelectorUnique(queryRoot, hostSelector)) return null;

      const host = safeQuerySelector(queryRoot, hostSelector);
      if (!host) return null;

      const shadowRoot = (host as HTMLElement).shadowRoot;
      if (!shadowRoot) return null;

      queryRoot = shadowRoot;
    }
  }

  // Try each selector candidate with uniqueness and fingerprint verification
  for (const selector of locator.selectors) {
    // Check if selector still matches exactly one element
    if (!isSelectorUnique(queryRoot, selector)) continue;

    const element = safeQuerySelector(queryRoot, selector);
    if (!element) continue;

    // Verify fingerprint matches to catch "same selector, different element" cases
    if (locator.fingerprint && !verifyFingerprint(element, locator.fingerprint)) {
      continue;
    }

    return element;
  }

  return null;
}

/**
 * Generate a unique key for an ElementLocator (for comparison/caching)
 */
export function locatorKey(locator: ElementLocator): string {
  const selectors = locator.selectors.join('|');
  const shadow = locator.shadowHostChain?.join('>') ?? '';
  const frame = locator.frameChain?.join('>') ?? '';
  return `frame:${frame}|shadow:${shadow}|sel:${selectors}`;
}
