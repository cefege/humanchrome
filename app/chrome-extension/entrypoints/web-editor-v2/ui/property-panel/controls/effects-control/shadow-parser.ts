/**
 * Shared CSS parsing helpers for box-shadow / filter:blur / backdrop-filter:blur.
 *
 * Extracted from the monolithic `effects-control.ts` so the parsing surface is
 * isolated from the DOM-heavy factory and can be unit-tested independently.
 */

import { splitTopLevel, tokenizeTopLevel } from '../css-helpers';

// =============================================================================
// Constants
// =============================================================================

/**
 * Regex to match CSS length tokens (e.g., "10px", "-5.5em", "0")
 * Note: Does not match calc()/var() - those are treated as "other" tokens
 */
const LENGTH_TOKEN_REGEX = /^-?(?:\d+\.?\d*|\.\d+)(?:[a-zA-Z%]+)?$/;

/** Check if a token looks like a CSS function call (e.g., calc(), var()) */
function isCssFunctionToken(token: string): boolean {
  return /^[a-zA-Z_-]+\s*\(/.test(token);
}

// =============================================================================
// Types
// =============================================================================

export interface ParsedBoxShadow {
  inset: boolean;
  offsetX: string;
  offsetY: string;
  blurRadius: string;
  spreadRadius: string;
  color: string;
}

export interface CssFunctionMatch {
  start: number;
  end: number;
  args: string;
}

// =============================================================================
// Length helpers
// =============================================================================

/**
 * Normalize a length value to include "px" unit if missing
 */
export function normalizeLength(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return '';

  // Pure number: add "px" unit
  if (/^-?(?:\d+|\d*\.\d+)$/.test(trimmed)) return `${trimmed}px`;

  // Trailing dot: "10." -> "10px"
  if (/^-?\d+\.$/.test(trimmed)) return `${trimmed.slice(0, -1)}px`;

  return trimmed;
}

// =============================================================================
// Box shadow
// =============================================================================

/**
 * Parse a single box-shadow value into components
 */
export function parseBoxShadow(raw: string): ParsedBoxShadow | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return null;

  // Get the first shadow (before comma)
  const first = splitTopLevel(trimmed, ',')[0]?.trim() ?? '';
  if (!first || first.toLowerCase() === 'none') return null;

  const tokens = tokenizeTopLevel(first);
  if (tokens.length === 0) return null;

  let inset = false;
  const lengthTokens: string[] = [];
  const otherTokens: string[] = [];

  for (const token of tokens) {
    if (/^inset$/i.test(token)) {
      inset = true;
      continue;
    }

    // Pure length values (numbers with optional units)
    if (LENGTH_TOKEN_REGEX.test(token)) {
      lengthTokens.push(token);
    }
    // CSS functions like calc(), var() - treat as length if in length position
    else if (isCssFunctionToken(token) && lengthTokens.length < 4) {
      lengthTokens.push(token);
    } else {
      otherTokens.push(token);
    }
  }

  // Need at least 2 length values (offset-x, offset-y)
  if (lengthTokens.length < 2) return null;

  return {
    inset,
    offsetX: lengthTokens[0] ?? '',
    offsetY: lengthTokens[1] ?? '',
    blurRadius: lengthTokens[2] ?? '',
    spreadRadius: lengthTokens[3] ?? '',
    color: otherTokens.join(' ').trim(),
  };
}

/**
 * Format box-shadow components into CSS value
 */
export function formatBoxShadow(input: {
  inset: boolean;
  offsetX: string;
  offsetY: string;
  blurRadius: string;
  spreadRadius: string;
  color: string;
}): string {
  const offsetX = normalizeLength(input.offsetX);
  const offsetY = normalizeLength(input.offsetY);
  const blurRadius = normalizeLength(input.blurRadius);
  const spreadRadius = normalizeLength(input.spreadRadius);
  const color = input.color.trim();

  // Return empty if no meaningful values
  if (!offsetX && !offsetY && !blurRadius && !spreadRadius && !color) return '';

  const parts: string[] = [];
  if (input.inset) parts.push('inset');

  parts.push(offsetX || '0px', offsetY || '0px');

  // Include blur if set or if spread is set
  if (blurRadius || spreadRadius) parts.push(blurRadius || '0px');
  if (spreadRadius) parts.push(spreadRadius);
  if (color) parts.push(color);

  return parts.join(' ');
}

/**
 * Update the first shadow in a comma-separated list, preserving others
 */
export function upsertFirstShadow(existing: string, first: string): string {
  const base = existing.trim();
  const firstTrimmed = first.trim();

  const segments = base && base.toLowerCase() !== 'none' ? splitTopLevel(base, ',') : [];
  const tail = segments
    .slice(1)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!firstTrimmed) return tail.join(', ');
  if (tail.length === 0) return firstTrimmed;
  return `${firstTrimmed}, ${tail.join(', ')}`;
}

// =============================================================================
// CSS function helpers (blur, etc.)
// =============================================================================

/**
 * Find a CSS function call (e.g., blur(...)) in a filter value
 * Handles word boundaries to avoid matching "myblur" when looking for "blur"
 */
export function findCssFunction(value: string, fnName: string): CssFunctionMatch | null {
  const src = value;
  const lower = src.toLowerCase();
  const needle = fnName.toLowerCase();

  let searchIndex = 0;

  while (searchIndex < src.length) {
    const found = lower.indexOf(needle, searchIndex);
    if (found < 0) return null;

    // Check word boundary: must not be preceded by a letter/digit/underscore/hyphen
    if (found > 0) {
      const prevChar = src[found - 1]!;
      if (/[a-zA-Z0-9_-]/.test(prevChar)) {
        searchIndex = found + needle.length;
        continue;
      }
    }

    // Find opening parenthesis (allow whitespace)
    let i = found + needle.length;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] !== '(') {
      searchIndex = found + needle.length;
      continue;
    }

    const openIndex = i;
    let depth = 0;
    let quote: "'" | '"' | null = null;
    let escape = false;

    for (let j = openIndex; j < src.length; j++) {
      const ch = src[j]!;

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === '\\') {
        escape = true;
        continue;
      }

      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }

      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }

      if (ch === '(') {
        depth++;
        continue;
      }

      if (ch === ')') {
        depth--;
        if (depth === 0) {
          return {
            start: found,
            end: j + 1,
            args: src.slice(openIndex + 1, j),
          };
        }
        continue;
      }
    }

    return null;
  }

  return null;
}

/**
 * Extract blur radius from filter/backdrop-filter value
 */
export function parseBlurRadius(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return '';

  const match = findCssFunction(trimmed, 'blur');
  return match ? match.args.trim() : '';
}

/**
 * Update blur() function in filter value, preserving other functions
 */
export function upsertBlurFunction(existing: string, radius: string): string {
  const base = existing.trim().toLowerCase() === 'none' ? '' : existing.trim();
  const match = base ? findCssFunction(base, 'blur') : null;

  const normalizedRadius = normalizeLength(radius);

  // Remove blur if radius is empty
  if (!normalizedRadius) {
    if (!match) return base;

    const left = base.slice(0, match.start).trimEnd();
    const right = base.slice(match.end).trimStart();
    if (left && right) return `${left} ${right}`.trim();
    return (left || right).trim();
  }

  const replacement = `blur(${normalizedRadius})`;

  // Add blur if not present
  if (!match) {
    if (!base) return replacement;
    return `${base} ${replacement}`.trim();
  }

  // Replace existing blur
  const left = base.slice(0, match.start).trimEnd();
  const right = base.slice(match.end).trimStart();
  const parts: string[] = [];
  if (left) parts.push(left);
  parts.push(replacement);
  if (right) parts.push(right);
  return parts.join(' ');
}
