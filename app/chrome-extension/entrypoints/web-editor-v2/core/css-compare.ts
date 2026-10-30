/**
 * CSS Compare Utilities (Phase 4.8)
 *
 * Provides robust CSS value comparison for HMR consistency verification.
 *
 * Design goals:
 * - Compare computed style values (format-agnostic: "1rem" vs "16px" both resolve to same computed value)
 * - Handle numeric tolerance for px-based values and transform matrices
 * - Provide detailed diff information for UI feedback
 *
 * Why computed styles?
 * - Editor mutates live DOM via inline styles for immediate preview
 * - Agent may persist changes via classes/CSS modules/Tailwind, not inline styles
 * - Comparing computed values avoids false mismatches from authoring format differences
 */

import { compareEditorComputed, normalizeEditorCssValue, normalizeEditorText } from 'humanchrome-shared';

// =============================================================================
// Types
// =============================================================================

/** Detailed diff for a single CSS property */
export interface ComputedDiffItem {
  /** CSS property name */
  readonly property: string;
  /** Expected value (from baseline) */
  readonly expected: string;
  /** Actual value (from current DOM) */
  readonly actual: string;
  /** Whether values match */
  readonly match: boolean;
  /** How comparison was determined */
  readonly reason?: 'exact' | 'px_epsilon' | 'matrix_epsilon' | 'string';
}

/** Result of comparing two computed style maps */
export interface CompareComputedResult {
  /** Overall match status */
  readonly matches: boolean;
  /** Per-property diff details */
  readonly diffs: readonly ComputedDiffItem[];
}

/** Options for CSS value comparison */
export interface CompareComputedOptions {
  /**
   * Epsilon for px-based numeric comparison.
   * Defaults to 0.5 to tolerate sub-pixel jitter from rounding.
   */
  readonly pxEpsilon?: number;
  /**
   * Epsilon for matrix()/matrix3d() numeric comparison.
   * Defaults to 1e-3 for floating-point precision tolerance.
   */
  readonly matrixEpsilon?: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_PX_EPSILON = 0.5;
const DEFAULT_MATRIX_EPSILON = 1e-3;

// Regex patterns (defined once for performance)
const PX_VALUE_REGEX = /(-?\d*\.?\d+(?:e[+-]?\d+)?)px/gi;
const MATRIX_NUMBER_REGEX = /-?\d*\.?\d+(?:e[+-]?\d+)?/gi;

// =============================================================================
// Public API
// =============================================================================

/**
 * Normalize text content for robust comparison.
 * Collapses whitespace and trims edges.
 */
export function normalizeText(text: string): string {
  return normalizeEditorText(String(text ?? ''));
}

/**
 * Read computed style values for specified CSS properties.
 *
 * @param element - Target element
 * @param properties - CSS property names to read
 * @returns Map of property name to computed value (normalized)
 */
export function readComputedMap(
  element: Element,
  properties: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};

  // Deduplicate and filter empty property names
  const uniqueProps: string[] = [];
  const seen = new Set<string>();
  for (const raw of properties) {
    const prop = String(raw ?? '').trim();
    if (!prop || seen.has(prop)) continue;
    seen.add(prop);
    uniqueProps.push(prop);
  }

  // Safely get computed style declaration
  let computed: CSSStyleDeclaration | null = null;
  try {
    computed = window.getComputedStyle(element);
  } catch {
    // Element may not be attached to DOM or other edge cases
    computed = null;
  }

  // Read each property
  for (const property of uniqueProps) {
    let value = '';
    try {
      value = computed?.getPropertyValue(property) ?? '';
    } catch {
      value = '';
    }
    result[property] = normalizeEditorCssValue(value);
  }

  return result;
}

/**
 * Compare two computed style maps with numeric tolerance.
 *
 * Comparison strategy:
 * 1. Exact string match → pass
 * 2. matrix()/matrix3d() numeric tolerance → pass if within epsilon
 * 3. px-based numeric tolerance → pass if same shape and within epsilon
 * 4. Otherwise → fail
 *
 * @param expected - Baseline computed values
 * @param actual - Current computed values
 * @param options - Comparison options
 * @returns Comparison result with per-property diffs
 */
export function compareComputed(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
  options: CompareComputedOptions = {},
): CompareComputedResult {
  return compareEditorComputed(
    Object.keys(expected).map((property) => ({ property, value: String(expected[property] ?? '') })),
    Object.keys(expected).map((property) => ({ property, value: String(actual[property] ?? '') })),
    options,
  );
}

