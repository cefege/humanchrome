/**
 * Color parsing + math primitives used by the gradient control.
 *
 * Pure functions only — no DOM access, no UI state. Safe to unit-test
 * in isolation and to share across other controls if ever needed.
 */

import {
  formatEditorRgba,
  interpolateEditorRgba,
  parseEditorHexColor,
  parseEditorRgbColor,
} from 'humanchrome-shared';

/** RGBA color representation for interpolation */
export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Clamp a value to [min, max] returning `min` when value is non-finite. */
export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/** Linear interpolation between two numbers */
export function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Clamp a value to byte range [0, 255] */
export function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Convert a byte value to 2-digit hex string */
export function toHexByte(value: number): string {
  return clampByte(value).toString(16).padStart(2, '0');
}

/** Convert RGBA to CSS color string (hex or rgba) */
export function rgbaToCss(color: RgbaColor): string {
  return formatEditorRgba(color);
}

/** Parse hex color (#RGB, #RGBA, #RRGGBB, #RRGGBBAA) to RGBA */
export function parseHexColorToRgba(raw: string): RgbaColor | null {
  return parseEditorHexColor(raw);
}

/** Parse RGB channel value (number or percentage) */
export function parseRgbChannel(token: string): number | null {
  const t = token.trim();
  if (!t) return null;

  if (t.endsWith('%')) {
    const n = Number(t.slice(0, -1));
    if (!Number.isFinite(n)) return null;
    return clampByte((n / 100) * 255);
  }

  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return clampByte(n);
}

/** Parse alpha channel value (number or percentage) */
export function parseAlphaChannel(token: string): number | null {
  const t = token.trim();
  if (!t) return null;

  if (t.endsWith('%')) {
    const n = Number(t.slice(0, -1));
    if (!Number.isFinite(n)) return null;
    return clampNumber(n / 100, 0, 1);
  }

  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return clampNumber(n, 0, 1);
}

/** Parse rgb()/rgba() color to RGBA (supports legacy and modern syntax) */
export function parseRgbColorToRgba(raw: string): RgbaColor | null {
  return parseEditorRgbColor(raw);
}

export function interpolateRgba(a: RgbaColor, b: RgbaColor, t: number): RgbaColor {
  return interpolateEditorRgba(a, b, t);
}

/**
 * Whether a stop color value contains a CSS variable reference and therefore
 * needs a resolved "placeholder" color for preview rendering.
 */
export function needsColorPlaceholder(value: string): boolean {
  return /\bvar\s*\(/i.test(value);
}
