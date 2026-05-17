/**
 * TestID Strategy - Attribute-based selector strategy
 *
 * Generates selectors based on stable attributes like data-testid, data-cy,
 * as well as semantic attributes like name, title, and alt.
 *
 * IMP-0098: extended with a runtime `resolve()` method that mirrors
 * Playwright's `getByTestId`. The set of recognized attribute names is
 * configurable per-client via extension storage (see `getTestIdAttributes`).
 *
 * IMP-0099: per-attribute weights enforce the Playwright-style priority
 * ladder so the primary candidate (candidates[0]) is the most stable
 * semantic identifier available:
 *   data-testid / data-cy / data-qa / ... → highest (test attributes)
 *   alt                                    → high (image/area semantic)
 *   title                                  → high
 *   name                                   → form-field semantic
 */

import type { SelectorCandidate, SelectorStrategy } from '../types';

// =============================================================================
// Constants
// =============================================================================

/** Tags that commonly use form-related attributes */
const FORM_ELEMENT_TAGS = new Set(['input', 'textarea', 'select', 'button']);

/** Tags that commonly use the 'alt' attribute */
const ALT_ATTRIBUTE_TAGS = new Set(['img', 'area']);

/** Tags that commonly use the 'title' attribute (most elements can have it) */
const TITLE_ATTRIBUTE_TAGS = new Set(['img', 'a', 'abbr', 'iframe', 'link']);

/**
 * Mapping of attributes to their preferred tag prefixes.
 * When an attribute-only selector is not unique, we try tag-prefixed form
 * only for elements where that attribute is semantically meaningful.
 */
const ATTR_TAG_PREFERENCES: Record<string, Set<string>> = {
  name: FORM_ELEMENT_TAGS,
  alt: ALT_ATTRIBUTE_TAGS,
  title: TITLE_ATTRIBUTE_TAGS,
};

/**
 * Default test-id attribute list — matches Playwright's default plus the
 * common Cypress/Storybook conventions agents have asked for.
 */
export const DEFAULT_TESTID_ATTRIBUTES = [
  'data-testid',
  'data-cy',
  'data-test',
  'data-qa',
] as const;

const TESTID_ATTRIBUTES_STORAGE_KEY = 'humanchrome.selector.testIdAttributes';

/**
 * IMP-0099: Weight ladder enforcing Playwright-style priority for the recorder.
 *
 * Test attributes (data-*) get the highest weight; semantic attributes
 * (alt, title, name) get progressively lower weights but still rank
 * above non-attribute strategies.
 */
const ATTR_WEIGHT: Record<string, number> = {
  'data-testid': 50,
  'data-test-id': 50,
  'data-testId': 50,
  'data-test': 50,
  'data-qa': 50,
  'data-cy': 50,
  alt: 20,
  title: 18,
  name: 15,
};

const DEFAULT_TESTID_WEIGHT = 50;

// =============================================================================
// Configuration (per-client extension storage)
// =============================================================================

/**
 * Override the active test-id attribute list. Persists to `chrome.storage.local`
 * so per-client preference survives a service-worker restart.
 *
 * Falls back to `DEFAULT_TESTID_ATTRIBUTES` if storage is unavailable or the
 * supplied list is empty.
 */
export async function setTestIdAttributes(
  attrs: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  const cleaned = attrs.map((a) => String(a).trim()).filter(Boolean);
  if (cleaned.length === 0) return DEFAULT_TESTID_ATTRIBUTES;
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return cleaned;
  try {
    await chrome.storage.local.set({ [TESTID_ATTRIBUTES_STORAGE_KEY]: cleaned });
  } catch {
    // Ignore storage failures — the call still returned the in-memory list.
  }
  return cleaned;
}

/**
 * Read the active test-id attribute list. Used by callers that need to
 * snapshot the current configuration (e.g. recorder generation).
 */
export async function getTestIdAttributes(): Promise<ReadonlyArray<string>> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return DEFAULT_TESTID_ATTRIBUTES;
  }
  try {
    const raw = await chrome.storage.local.get([TESTID_ATTRIBUTES_STORAGE_KEY]);
    const list = raw?.[TESTID_ATTRIBUTES_STORAGE_KEY];
    if (Array.isArray(list) && list.length > 0) {
      return list.map((v) => String(v));
    }
  } catch {
    // ignore
  }
  return DEFAULT_TESTID_ATTRIBUTES;
}

// =============================================================================
// Helpers
// =============================================================================

function makeAttrSelector(attr: string, value: string, cssEscape: (v: string) => string): string {
  return `[${attr}="${cssEscape(value)}"]`;
}

/**
 * Determine if tag prefix should be tried for disambiguation.
 *
 * Rules:
 * - data-* attributes: try for form elements only
 * - name: try for form elements (input, textarea, select, button)
 * - alt: try for img, area, input[type=image]
 * - title: try for common elements that use title semantically
 * - Default: try for any tag
 */
function shouldTryTagPrefix(attr: string, tag: string, element: Element): boolean {
  if (!tag) return false;

  // For data-* test attributes, use form element heuristic
  if (attr.startsWith('data-')) {
    return FORM_ELEMENT_TAGS.has(tag);
  }

  // For semantic attributes, check the preference mapping
  const preferredTags = ATTR_TAG_PREFERENCES[attr];
  if (preferredTags) {
    if (preferredTags.has(tag)) return true;

    // Special case: input[type=image] also uses alt
    if (attr === 'alt' && tag === 'input') {
      const type = element.getAttribute('type');
      return type === 'image';
    }

    return false;
  }

  // Default: try tag prefix for any element
  return true;
}

function weightFor(attr: string): number {
  return ATTR_WEIGHT[attr] ?? DEFAULT_TESTID_WEIGHT;
}

// =============================================================================
// Runtime resolver
// =============================================================================

function cssEscapeBasic(v: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(v);
  return v.replace(/(["\\])/g, '\\$1');
}

/**
 * Resolve elements whose configured test-id attribute equals `value`.
 *
 * @param value Attribute value to match (exact).
 * @param scope ParentNode root for the search.
 * @param attrs Optional explicit attribute list. When omitted, defaults to
 *              `DEFAULT_TESTID_ATTRIBUTES`. Pass an array from
 *              `getTestIdAttributes()` to honor per-client configuration.
 */
export function resolveByTestId(
  value: string,
  scope: ParentNode,
  attrs: ReadonlyArray<string> = DEFAULT_TESTID_ATTRIBUTES,
): Element[] {
  const target = String(value || '').trim();
  if (!target) return [];
  const escaped = cssEscapeBasic(target);
  const out: Element[] = [];
  const seen = new Set<Element>();
  for (const attr of attrs) {
    const a = String(attr).trim();
    if (!a) continue;
    let matches: NodeListOf<Element> | undefined;
    try {
      matches = scope.querySelectorAll(`[${a}="${escaped}"]`);
    } catch {
      continue;
    }
    if (!matches) continue;
    for (const el of Array.from(matches)) {
      if (seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
  }
  return out;
}

// =============================================================================
// Strategy Export
// =============================================================================

export const testIdStrategy: SelectorStrategy & {
  resolve: (value: string, scope: ParentNode, extras?: { attribute?: string }) => Element[];
} = {
  id: 'testid',

  generate(ctx) {
    const { element, options, helpers } = ctx;
    const out: SelectorCandidate[] = [];
    const tag = element.tagName?.toLowerCase?.() ?? '';

    for (const attr of options.testIdAttributes) {
      const raw = element.getAttribute(attr);
      const value = raw?.trim();
      if (!value) continue;

      const attrOnly = makeAttrSelector(attr, value, helpers.cssEscape);
      const weight = weightFor(attr);

      // Try attribute-only selector first
      if (helpers.isUnique(attrOnly)) {
        out.push({
          type: 'attr',
          value: attrOnly,
          weight,
          source: 'generated',
          strategy: 'testid',
        });
        continue;
      }

      // Try tag-prefixed form if appropriate for this attribute/element combo
      if (shouldTryTagPrefix(attr, tag, element)) {
        const withTag = `${tag}${attrOnly}`;
        if (helpers.isUnique(withTag)) {
          out.push({
            type: 'attr',
            value: withTag,
            weight,
            source: 'generated',
            strategy: 'testid',
          });
        }
      }
    }

    return out;
  },

  resolve(value, scope, extras) {
    const attr = extras?.attribute?.trim();
    if (attr) return resolveByTestId(value, scope, [attr]);
    return resolveByTestId(value, scope, DEFAULT_TESTID_ATTRIBUTES);
  },
};
