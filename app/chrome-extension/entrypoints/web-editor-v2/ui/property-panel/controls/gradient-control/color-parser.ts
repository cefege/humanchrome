/**
 * Color parsing + math primitives used by the gradient control.
 *
 * Pure functions only — no DOM access, no UI state. Safe to unit-test
 * in isolation and to share across other controls if ever needed.
 */

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
  const a = clampNumber(color.a, 0, 1);
  if (a >= 1) {
    return `#${toHexByte(color.r)}${toHexByte(color.g)}${toHexByte(color.b)}`;
  }
  const alpha = Math.round(a * 1000) / 1000;
  return `rgba(${clampByte(color.r)}, ${clampByte(color.g)}, ${clampByte(color.b)}, ${alpha})`;
}

/** Parse hex color (#RGB, #RGBA, #RRGGBB, #RRGGBBAA) to RGBA */
export function parseHexColorToRgba(raw: string): RgbaColor | null {
  const v = raw.trim().toLowerCase();
  if (!v.startsWith('#')) return null;

  // #RGB
  if (/^#[0-9a-f]{3}$/.test(v)) {
    const r = Number.parseInt(v[1]! + v[1]!, 16);
    const g = Number.parseInt(v[2]! + v[2]!, 16);
    const b = Number.parseInt(v[3]! + v[3]!, 16);
    return { r, g, b, a: 1 };
  }

  // #RGBA
  if (/^#[0-9a-f]{4}$/.test(v)) {
    const r = Number.parseInt(v[1]! + v[1]!, 16);
    const g = Number.parseInt(v[2]! + v[2]!, 16);
    const b = Number.parseInt(v[3]! + v[3]!, 16);
    const a = Number.parseInt(v[4]! + v[4]!, 16) / 255;
    return { r, g, b, a };
  }

  // #RRGGBB
  if (/^#[0-9a-f]{6}$/.test(v)) {
    const r = Number.parseInt(v.slice(1, 3), 16);
    const g = Number.parseInt(v.slice(3, 5), 16);
    const b = Number.parseInt(v.slice(5, 7), 16);
    return { r, g, b, a: 1 };
  }

  // #RRGGBBAA
  if (/^#[0-9a-f]{8}$/.test(v)) {
    const r = Number.parseInt(v.slice(1, 3), 16);
    const g = Number.parseInt(v.slice(3, 5), 16);
    const b = Number.parseInt(v.slice(5, 7), 16);
    const a = Number.parseInt(v.slice(7, 9), 16) / 255;
    return { r, g, b, a };
  }

  return null;
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
  const trimmed = raw.trim();
  if (!/^rgba?\(/i.test(trimmed)) return null;

  const openIndex = trimmed.indexOf('(');
  const closeIndex = trimmed.lastIndexOf(')');
  if (openIndex < 0 || closeIndex < openIndex) return null;

  const inner = trimmed.slice(openIndex + 1, closeIndex).trim();
  if (!inner) return null;

  let channelsPart = inner;
  let alphaPart: string | null = null;

  // Modern syntax: rgb(0 0 0 / 0.5)
  const slashIndex = inner.indexOf('/');
  if (slashIndex !== -1) {
    channelsPart = inner.slice(0, slashIndex).trim();
    alphaPart = inner.slice(slashIndex + 1).trim();
  }

  // Split by comma (legacy) or whitespace (modern)
  const channelTokens = channelsPart.includes(',')
    ? channelsPart
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : channelsPart
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean);

  if (channelTokens.length < 3) return null;

  const r = parseRgbChannel(channelTokens[0]!);
  const g = parseRgbChannel(channelTokens[1]!);
  const b = parseRgbChannel(channelTokens[2]!);
  if (r === null || g === null || b === null) return null;

  let a = 1;

  // Legacy rgba(r,g,b,a) comma syntax
  if (!alphaPart && channelTokens.length >= 4) {
    alphaPart = channelTokens[3]!;
  }

  if (alphaPart) {
    const parsedA = parseAlphaChannel(alphaPart);
    if (parsedA !== null) a = parsedA;
  }

  return { r, g, b, a };
}

/** Interpolate between two RGBA colors */
export function interpolateRgba(a: RgbaColor, b: RgbaColor, t: number): RgbaColor {
  const clampedT = clampNumber(t, 0, 1);
  return {
    r: lerpNumber(a.r, b.r, clampedT),
    g: lerpNumber(a.g, b.g, clampedT),
    b: lerpNumber(a.b, b.b, clampedT),
    a: lerpNumber(a.a, b.a, clampedT),
  };
}

/**
 * Whether a stop color value contains a CSS variable reference and therefore
 * needs a resolved "placeholder" color for preview rendering.
 */
export function needsColorPlaceholder(value: string): boolean {
  return /\bvar\s*\(/i.test(value);
}
