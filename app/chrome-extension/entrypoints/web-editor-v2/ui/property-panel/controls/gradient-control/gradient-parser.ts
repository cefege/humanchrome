/**
 * CSS gradient parsing.
 *
 * Turns `linear-gradient(...)` / `radial-gradient(...)` strings into a
 * structured `ParsedGradient` shape used by the gradient control UI.
 *
 * Pure functions only — no DOM access.
 */

import { splitTopLevel, tokenizeTopLevel } from '../css-helpers';
import { clampNumber } from './color-parser';

// =============================================================================
// Constants
// =============================================================================

export const GRADIENT_TYPES = [
  { value: 'none', label: 'None' },
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
] as const;

export type GradientType = (typeof GRADIENT_TYPES)[number]['value'];

export const RADIAL_SHAPES = [
  { value: 'ellipse', label: 'Ellipse' },
  { value: 'circle', label: 'Circle' },
] as const;

export type RadialShape = (typeof RADIAL_SHAPES)[number]['value'];

export const DEFAULT_LINEAR_ANGLE = 180;
export const DEFAULT_POSITION = 50;

export const DEFAULT_STOP_1: GradientStop = { color: '#000000', position: 0 };
export const DEFAULT_STOP_2: GradientStop = { color: '#ffffff', position: 100 };

// =============================================================================
// Types
// =============================================================================

/** Basic gradient stop (used in parsing and UI state) */
export interface GradientStop {
  color: string;
  position: number;
  /**
   * Resolved/computed color when `color` contains var().
   * Populated during sync when inline value contains CSS variables.
   */
  placeholderColor?: string;
}

export interface ParsedLinearGradient {
  type: 'linear';
  angle: number;
  stops: GradientStop[];
}

export interface ParsedRadialGradient {
  type: 'radial';
  shape: RadialShape;
  position: { x: number; y: number } | null;
  stops: GradientStop[];
}

export type ParsedGradient = ParsedLinearGradient | ParsedRadialGradient;

export interface ParsedStop {
  color: string;
  position: number | null;
}

// =============================================================================
// Token helpers
// =============================================================================

export function isNoneValue(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed || trimmed.toLowerCase() === 'none';
}

export function parseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function parseAngleToken(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(-?(?:\d+\.?\d*|\.\d+))\s*deg$/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

export function parsePercentToken(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(-?(?:\d+\.?\d*|\.\d+))\s*%$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/** Parse X position keyword (left/center/right or %) */
export function parsePositionX(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  const pct = parsePercentToken(trimmed);
  if (pct !== null) return pct;

  if (trimmed === 'center') return 50;
  if (trimmed === 'left') return 0;
  if (trimmed === 'right') return 100;

  return null;
}

/** Parse Y position keyword (top/center/bottom or %) */
export function parsePositionY(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  const pct = parsePercentToken(trimmed);
  if (pct !== null) return pct;

  if (trimmed === 'center') return 50;
  if (trimmed === 'top') return 0;
  if (trimmed === 'bottom') return 100;

  return null;
}

/** Check if a token is an X-axis keyword */
export function isXKeyword(raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  return lower === 'left' || lower === 'right';
}

/** Check if a token is a Y-axis keyword */
export function isYKeyword(raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  return lower === 'top' || lower === 'bottom';
}

export function clampAngle(value: number): number {
  return clampNumber(value, 0, 360);
}

export function clampPercent(value: number): number {
  return clampNumber(value, 0, 100);
}

// =============================================================================
// Stop parsing + normalization
// =============================================================================

export function parseColorStop(raw: string): ParsedStop | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const tokens = tokenizeTopLevel(trimmed);
  if (tokens.length === 0) return null;

  const color = tokens[0] ?? '';
  if (!color) return null;

  let position: number | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const p = parsePercentToken(tokens[i] ?? '');
    if (p !== null) {
      position = p;
      break;
    }
  }

  return { color, position };
}

/**
 * Normalize stop positions following CSS gradient specification:
 * - First stop defaults to 0%, last stop defaults to 100%
 * - Enforces monotonically non-decreasing positions (CSS spec)
 * - Missing positions are distributed evenly between defined positions
 * - All positions are clamped to 0..100
 */
export function normalizeStopPositions(stops: ParsedStop[]): GradientStop[] {
  if (stops.length === 0) return [];
  if (stops.length === 1) {
    return [
      {
        color: stops[0]!.color.trim() || DEFAULT_STOP_1.color,
        position: clampPercent(stops[0]!.position ?? 0),
      },
    ];
  }

  // Extract colors and initial positions
  const colors = stops.map((s) => s.color.trim() || DEFAULT_STOP_1.color);
  const positions: Array<number | null> = stops.map((s) =>
    s.position === null ? null : clampPercent(s.position),
  );

  // Default first position to 0 if not defined
  if (positions[0] === null) {
    positions[0] = 0;
  }

  // Default last position to 100 if not defined
  const lastIndex = positions.length - 1;
  if (positions[lastIndex] === null) {
    positions[lastIndex] = 100;
  }

  // CSS spec: Enforce monotonically non-decreasing positions
  // If a later explicit position is less than an earlier one, bump it up
  let maxSoFar = positions[0] ?? 0;
  for (let i = 1; i < positions.length; i++) {
    const pos = positions[i];
    if (pos !== null) {
      if (pos < maxSoFar) {
        positions[i] = maxSoFar;
      } else {
        maxSoFar = pos;
      }
    }
  }

  // Fill in missing positions by linear interpolation
  // Find runs of null positions and distribute them evenly
  let runStart: number | null = null;

  for (let i = 0; i < positions.length; i++) {
    if (positions[i] === null) {
      if (runStart === null) {
        runStart = i;
      }
    } else {
      if (runStart !== null) {
        // Fill the run from runStart to i-1
        const prevPos = positions[runStart - 1] ?? 0;
        const nextPos = positions[i] ?? 100;
        const runLength = i - runStart + 1;

        for (let j = runStart; j < i; j++) {
          const t = (j - runStart + 1) / runLength;
          positions[j] = prevPos + (nextPos - prevPos) * t;
        }
        runStart = null;
      }
    }
  }

  return stops.map((_, i) => ({
    color: colors[i]!,
    position: clampPercent(positions[i] ?? 0),
  }));
}

/**
 * Legacy normalize function for backward compatibility.
 * @deprecated Use normalizeStopPositions for N stops
 */
export function normalizeStops(
  stops: [ParsedStop, ParsedStop],
): [GradientStop, GradientStop] {
  const normalized = normalizeStopPositions(stops);
  return [normalized[0] ?? { ...DEFAULT_STOP_1 }, normalized[1] ?? { ...DEFAULT_STOP_2 }];
}

// =============================================================================
// Gradient function-call parsing
// =============================================================================

export function parseGradientFunctionCall(
  value: string,
): { kind: 'linear' | 'radial'; args: string } | null {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();

  let kind: 'linear' | 'radial' | null = null;
  let fnName = '';

  if (lower.startsWith('linear-gradient')) {
    kind = 'linear';
    fnName = 'linear-gradient';
  } else if (lower.startsWith('radial-gradient')) {
    kind = 'radial';
    fnName = 'radial-gradient';
  } else {
    return null;
  }

  let i = fnName.length;
  while (i < trimmed.length && /\s/.test(trimmed[i]!)) i++;
  if (trimmed[i] !== '(') return null;

  const openIndex = i;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let j = openIndex; j < trimmed.length; j++) {
    const ch = trimmed[j]!;

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
        // Check no trailing content
        const trailing = trimmed.slice(j + 1).trim();
        if (trailing) return null;

        const args = trimmed.slice(openIndex + 1, j);
        return { kind, args };
      }
    }
  }

  return null;
}

export function parseLinearGradient(args: string): ParsedLinearGradient | null {
  const parts = splitTopLevel(args, ',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Need at least 2 color stops
  if (parts.length < 2) return null;

  const firstPart = parts[0] ?? '';
  const firstLower = firstPart.toLowerCase();

  // Reject unsupported direction keywords: "to left", "to right", "to top", etc.
  // These are valid CSS but we only support angle-based linear gradients
  if (firstLower.startsWith('to ')) {
    return null;
  }

  // Check if first part is an angle
  const maybeAngle = parseAngleToken(firstPart);

  let angle = DEFAULT_LINEAR_ANGLE;
  let stopStartIndex = 0;

  if (maybeAngle !== null) {
    // Format: linear-gradient(angle, stop1, stop2, ...)
    if (parts.length < 3) return null;
    angle = maybeAngle;
    stopStartIndex = 1;
  }

  // Parse all color stops
  const stopParts = parts.slice(stopStartIndex);
  const parsedStops: ParsedStop[] = [];

  for (const raw of stopParts) {
    const stop = parseColorStop(raw);
    if (!stop) return null;
    parsedStops.push(stop);
  }

  // Must have at least 2 stops
  if (parsedStops.length < 2) return null;

  return {
    type: 'linear',
    angle: clampAngle(angle),
    stops: normalizeStopPositions(parsedStops),
  };
}

/** Size keywords we don't support - return null to show as "none" */
const UNSUPPORTED_RADIAL_SIZE_KEYWORDS = new Set([
  'closest-side',
  'farthest-side',
  'closest-corner',
  'farthest-corner',
]);

export function parseRadialGradient(args: string): ParsedRadialGradient | null {
  const parts = splitTopLevel(args, ',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length < 2) return null;

  let shape: RadialShape = 'ellipse';
  let position: { x: number; y: number } | null = null;
  let stopStartIndex = 0;

  const first = parts[0] ?? '';
  const tokens = tokenizeTopLevel(first);
  const lowerTokens = tokens.map((t) => t.toLowerCase());

  // Reject unsupported size keywords - valid CSS but we only support basic shapes
  for (const token of lowerTokens) {
    if (UNSUPPORTED_RADIAL_SIZE_KEYWORDS.has(token)) {
      return null;
    }
  }

  const atIndex = lowerTokens.indexOf('at');
  const hasAt = atIndex >= 0;

  const hasCircle = lowerTokens.includes('circle');
  const hasEllipse = lowerTokens.includes('ellipse');
  const hasShape = hasCircle || hasEllipse;

  if (hasShape || hasAt) {
    stopStartIndex = 1;

    if (hasCircle) shape = 'circle';
    else if (hasEllipse) shape = 'ellipse';

    if (hasAt) {
      const token1 = tokens[atIndex + 1] ?? '';
      const token2 = tokens[atIndex + 2] ?? '';

      // Handle position parsing with axis awareness
      // CSS allows "at top right" (Y then X) or "at right top" (X then Y)
      let x: number | null = null;
      let y: number | null = null;

      // Check if first token is a Y keyword (top/bottom)
      if (isYKeyword(token1)) {
        // "at top" or "at top right" - first is Y
        y = parsePositionY(token1);
        x = token2 ? parsePositionX(token2) : null;
      } else if (isXKeyword(token1)) {
        // "at left" or "at left top" - first is X
        x = parsePositionX(token1);
        y = token2 ? parsePositionY(token2) : null;
      } else {
        // Default: treat as "X Y" order (most common for percentages)
        x = parsePositionX(token1);
        y = token2 ? parsePositionY(token2) : null;
      }

      position = {
        x: clampPercent(x ?? DEFAULT_POSITION),
        y: clampPercent(y ?? DEFAULT_POSITION),
      };
    }
  }

  // Parse all color stops
  const stopParts = parts.slice(stopStartIndex);
  const parsedStops: ParsedStop[] = [];

  for (const raw of stopParts) {
    const stop = parseColorStop(raw);
    if (!stop) return null;
    parsedStops.push(stop);
  }

  // Must have at least 2 stops
  if (parsedStops.length < 2) return null;

  return {
    type: 'radial',
    shape,
    position,
    stops: normalizeStopPositions(parsedStops),
  };
}

export function parseGradient(value: string): ParsedGradient | null {
  const fn = parseGradientFunctionCall(value);
  if (!fn) return null;
  return fn.kind === 'linear' ? parseLinearGradient(fn.args) : parseRadialGradient(fn.args);
}

/**
 * Build placeholder color mapping from inline stops to computed stops.
 * Uses nearest-neighbor matching by stop position (0..100).
 * This handles cases where normalization may produce slightly different positions.
 *
 * @param inlineStops - Stops parsed from inline CSS (may contain var())
 * @param computedStops - Stops parsed from computed CSS (resolved colors)
 * @returns Array of placeholder colors aligned to inlineStops indices
 */
export function buildPlaceholderMapping(
  inlineStops: GradientStop[],
  computedStops: GradientStop[],
): string[] {
  if (inlineStops.length === 0 || computedStops.length === 0) {
    return [];
  }

  return inlineStops.map((inlineStop) => {
    let nearestStop = computedStops[0]!;
    let minDistance = Math.abs(nearestStop.position - inlineStop.position);

    for (let i = 1; i < computedStops.length; i++) {
      const candidate = computedStops[i]!;
      const distance = Math.abs(candidate.position - inlineStop.position);
      if (distance < minDistance) {
        nearestStop = candidate;
        minDistance = distance;
      }
    }

    return nearestStop.color;
  });
}
