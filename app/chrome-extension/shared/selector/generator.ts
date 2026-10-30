/**
 * Selector Generator - produces multiple candidate selectors for a DOM element.
 */

import { selectorPolicy } from 'humanchrome-shared';
import type {
  NormalizedSelectorGenerationOptions,
  SelectorCandidate,
  SelectorGenerationOptions,
  SelectorStrategy,
  SelectorStrategyContext,
  SelectorTarget,
  ExtendedSelectorTarget,
} from './types';
import { DEFAULT_SELECTOR_STRATEGIES } from './strategies';
import { computeDomPath } from './dom-path';
import { computeFingerprint } from './fingerprint';

export function normalizeSelectorGenerationOptions(
  options: SelectorGenerationOptions | undefined,
): NormalizedSelectorGenerationOptions {
  return selectorPolicy.normalizeRustSelectorOptions(options);
}

/** Uses native CSS.escape when available, otherwise the Rust-owned compatibility fallback. */
export function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return selectorPolicy.rustCssEscapeFallback(value);
}

function getQueryRoot(element: Element): ParentNode {
  const root = element.getRootNode?.();
  if (root instanceof ShadowRoot) return root;
  if (typeof document !== 'undefined') return document;
  throw new Error('Selector generator requires a DOM-like environment');
}

function safeQueryAll(root: ParentNode, selector: string): ReadonlyArray<Element> {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function isUnique(root: ParentNode, selector: string): boolean {
  try {
    return root.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}


export interface GenerateSelectorTargetOptions extends SelectorGenerationOptions {
  root?: ParentNode;
  strategies?: ReadonlyArray<SelectorStrategy>;
}

export function generateSelectorTarget(
  element: Element,
  options: GenerateSelectorTargetOptions = {},
): SelectorTarget {
  const normalized = normalizeSelectorGenerationOptions(options);
  const root = options.root ?? getQueryRoot(element);

  const helpers = {
    cssEscape,
    isUnique: (selector: string) => isUnique(root, selector),
    safeQueryAll: (selector: string) => safeQueryAll(root, selector),
  };

  const ctx: SelectorStrategyContext = {
    element,
    root,
    options: normalized,
    helpers,
  };

  const strategies = options.strategies ?? DEFAULT_SELECTOR_STRATEGIES;

  const raw: SelectorCandidate[] = [];
  for (const strategy of strategies) {
    const produced = strategy.generate(ctx);
    for (const c0 of produced) {
      raw.push({
        ...c0,
        source: c0.source ?? 'generated',
        strategy: c0.strategy ?? strategy.id,
      });
    }
  }

  return selectorPolicy.rankSelectorCandidates(
    raw,
    options,
    element.tagName?.toLowerCase?.() ?? undefined,
  ) as SelectorTarget;
}

// =============================================================================
// Extended Selector Target (Phase 1.2)
// =============================================================================

function safeMatches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

/**
 * Pick the best selector for a shadow host element.
 * Prefers unique CSS/attr selectors from the generated candidates.
 */
function pickShadowHostSelector(
  host: Element,
  hostRoot: ParentNode,
  options: GenerateSelectorTargetOptions,
): string | null {
  const hostTarget = generateSelectorTarget(host, { ...options, root: hostRoot });

  let fallback: string | null = null;

  // Try to find a unique selector from candidates
  for (const candidate of hostTarget.candidates) {
    if (candidate.type !== 'css' && candidate.type !== 'attr') continue;

    const selector = String(candidate.value || '').trim();
    if (!selector) continue;

    // Verify the selector actually matches the host
    if (!safeMatches(host, selector)) continue;

    // Check uniqueness in the host's root
    if (isUnique(hostRoot, selector)) {
      return selector;
    }

    // Keep first matching selector as fallback
    if (!fallback) {
      fallback = selector;
    }
  }

  // Try the primary selector
  const primary = typeof hostTarget.selector === 'string' ? hostTarget.selector.trim() : '';
  if (primary && safeMatches(host, primary)) {
    return primary;
  }

  return fallback;
}

/**
 * Compute shadow host selector chain (outer -> inner).
 *
 * Returns an empty array when:
 * - Element is not inside Shadow DOM
 * - A host selector cannot be generated for any boundary
 */
function computeShadowHostChain(
  element: Element,
  options: GenerateSelectorTargetOptions,
): string[] {
  const chain: string[] = [];
  let current: Element = element;

  while (true) {
    const rootNode = current.getRootNode?.();
    if (!(rootNode instanceof ShadowRoot)) {
      break;
    }

    const host = rootNode.host;
    if (!(host instanceof Element)) {
      break;
    }

    const hostRoot = getQueryRoot(host);
    const hostSelector = pickShadowHostSelector(host, hostRoot, options);

    if (!hostSelector) {
      // Cannot generate selector for this host, return empty chain
      return [];
    }

    chain.unshift(hostSelector);
    current = host;
  }

  return chain;
}

/**
 * Generate selector target with additional metadata (Phase 1.2).
 *
 * This function generates a complete ElementLocator-like structure including:
 * - fingerprint: for fuzzy element matching
 * - domPath: for fast element recovery
 * - shadowHostChain: for Shadow DOM traversal
 *
 * @example
 * ```ts
 * const target = generateExtendedSelectorTarget(buttonElement);
 * // target.fingerprint = "button|id=submit|class=btn.primary"
 * // target.domPath = [0, 2, 1]
 * // target.shadowHostChain = ["my-component"] or []
 * ```
 */
export function generateExtendedSelectorTarget(
  element: Element,
  options: GenerateSelectorTargetOptions = {},
): ExtendedSelectorTarget {
  const base = generateSelectorTarget(element, options);

  return {
    ...base,
    fingerprint: computeFingerprint(element),
    domPath: computeDomPath(element),
    shadowHostChain: computeShadowHostChain(element, options),
  };
}
