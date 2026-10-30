/**
 * Shared CSS parsing helpers for box-shadow / filter:blur / backdrop-filter:blur.
 *
 * Extracted from the monolithic `effects-control.ts` so the parsing surface is
 * isolated from the DOM-heavy factory and can be unit-tested independently.
 */

import { splitTopLevel } from '../css-helpers';
import {
  findEditorCssFunction,
  normalizeEditorLength,
  parseEditorBoxShadow,
} from 'humanchrome-shared';


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

export function normalizeLength(raw: string): string {
  return normalizeEditorLength(raw);
}

// =============================================================================
// Box shadow
// =============================================================================

/**
 * Parse a single box-shadow value into components
 */
export function parseBoxShadow(raw: string): ParsedBoxShadow | null {
  return parseEditorBoxShadow(raw);
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
  return findEditorCssFunction(value, fnName);
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
