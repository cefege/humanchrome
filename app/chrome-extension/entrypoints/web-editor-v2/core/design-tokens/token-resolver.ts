/**
 * Token Resolver (Phase 5.4)
 *
 * Resolves CSS custom property values for specific element contexts.
 *
 * Key features:
 * - Parse and format var() expressions
 * - Read computed custom property values
 * - Check token availability in element context
 *
 * Design decisions:
 * - Primarily uses getComputedStyle() for resolution (safe, no DOM mutation)
 * - Avoids probe element insertion by default (prevents layout/selector side effects)
 * - Probe-based resolution reserved for future phases if needed
 */

import type {
  CssVarName,
  CssVarReference,
  TokenResolution,
  TokenResolvedForProperty,
  TokenResolutionMethod,
} from './types';

import {
  extractEditorCssVarNames,
  formatEditorCssVar,
  parseEditorCssVar,
} from 'humanchrome-shared';

// =============================================================================
// Types
// =============================================================================

/** Options for creating a token resolver */
export interface TokenResolverOptions {
  /**
   * Enable probe-based resolution for property previews.
   * @default false (Phase 5.4 recommendation)
   */
  enableProbe?: boolean;
}

/** Options for resolving a token for a specific property */
export interface ResolveForPropertyOptions {
  /** Optional fallback value for var() expression */
  fallback?: string;
  /** Attempt to compute a preview value */
  preview?: boolean;
}

/** Token resolver public interface */
export interface TokenResolver {
  /**
   * Format a CSS var() expression.
   * @example formatCssVar('--color-primary') => 'var(--color-primary)'
   * @example formatCssVar('--color-primary', 'blue') => 'var(--color-primary, blue)'
   */
  formatCssVar(name: CssVarName, fallback?: string): string;

  /**
   * Parse a var() expression.
   * @example parseCssVar('var(--color)') => { name: '--color' }
   * @example parseCssVar('var(--color, blue)') => { name: '--color', fallback: 'blue' }
   * @returns null if not a valid var() expression
   */
  parseCssVar(value: string): CssVarReference | null;

  /**
   * Extract all CSS variable names from an arbitrary value.
   * @example extractCssVarNames('calc(var(--a) + var(--b))') => ['--a', '--b']
   */
  extractCssVarNames(value: string): CssVarName[];

  /**
   * Read the computed value of a custom property for an element.
   * Uses getComputedStyle().getPropertyValue().
   */
  readComputedValue(element: Element, name: CssVarName): string;

  /**
   * Resolve a token's availability and value in an element's context.
   */
  resolveToken(element: Element, name: CssVarName): TokenResolution;

  /**
   * Build the CSS value to apply a token to a specific property.
   * Returns metadata useful for UI display and preview.
   */
  resolveTokenForProperty(
    element: Element,
    name: CssVarName,
    cssProperty: string,
    options?: ResolveForPropertyOptions,
  ): TokenResolvedForProperty;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a token resolver instance.
 */
export function createTokenResolver(options: TokenResolverOptions = {}): TokenResolver {
  const enableProbe = Boolean(options.enableProbe);

  // ===========================================================================
  // var() Formatting and Parsing
  // ===========================================================================

  function formatCssVar(name: CssVarName, fallback?: string): string {
    return formatEditorCssVar(name, fallback);
  }

  function parseCssVar(value: string): CssVarReference | null {
    return parseEditorCssVar(String(value ?? '')) as CssVarReference | null;
  }

  function extractCssVarNames(value: string): CssVarName[] {
    return extractEditorCssVarNames(String(value ?? '')) as CssVarName[];
  }

  // ===========================================================================
  // Computed Value Reading
  // ===========================================================================

  function readComputedValue(element: Element, name: CssVarName): string {
    try {
      const computed = window.getComputedStyle(element);
      return computed.getPropertyValue(name).trim();
    } catch {
      return '';
    }
  }

  // ===========================================================================
  // Token Resolution
  // ===========================================================================

  function resolveToken(element: Element, name: CssVarName): TokenResolution {
    const computedValue = readComputedValue(element, name);

    return {
      token: name,
      computedValue,
      availability: computedValue ? 'available' : 'unset',
    };
  }

  function resolveTokenForProperty(
    element: Element,
    name: CssVarName,
    cssProperty: string,
    options: ResolveForPropertyOptions = {},
  ): TokenResolvedForProperty {
    const cssValue = formatCssVar(name, options.fallback);

    // Determine resolution method
    // Phase 5.4: Avoid probe by default, use computed custom property
    const method: TokenResolutionMethod = enableProbe && options.preview ? 'probe' : 'computed';

    // For 'computed' method, we can provide the custom property value
    // but NOT the resolved value for a specific CSS property
    // (that would require a probe element)
    let resolvedValue: string | undefined;

    if (method === 'computed' && options.preview) {
      // Best-effort: return the custom property value itself
      resolvedValue = readComputedValue(element, name) || undefined;
    }

    return {
      token: name,
      cssProperty,
      cssValue,
      resolvedValue,
      method,
    };
  }

  return {
    formatCssVar,
    parseCssVar,
    extractCssVarNames,
    readComputedValue,
    resolveToken,
    resolveTokenForProperty,
  };
}
