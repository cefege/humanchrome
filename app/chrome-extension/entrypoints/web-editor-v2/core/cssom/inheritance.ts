/**
 * CSS property inheritance lookup (IMP-0046 slice 1).
 *
 * Pure data — the curated set of inheritable property names plus a small
 * predicate. Extracted from cssom-styles-collector.ts so the cascade engine
 * isn't part of the dependency graph just to ask "does this property
 * inherit?". Custom properties (--foo) always inherit per the CSS spec.
 */

export const INHERITED_PROPERTIES = new Set<string>([
  // Color & appearance
  'color',
  'color-scheme',
  'caret-color',
  'accent-color',

  // Typography / fonts
  'font',
  'font-family',
  'font-feature-settings',
  'font-kerning',
  'font-language-override',
  'font-optical-sizing',
  'font-palette',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-synthesis',
  'font-synthesis-small-caps',
  'font-synthesis-style',
  'font-synthesis-weight',
  'font-variant',
  'font-variant-alternates',
  'font-variant-caps',
  'font-variant-east-asian',
  'font-variant-emoji',
  'font-variant-ligatures',
  'font-variant-numeric',
  'font-variant-position',
  'font-variation-settings',
  'font-weight',
  'letter-spacing',
  'line-height',
  'text-rendering',
  'text-size-adjust',
  'text-transform',
  'text-indent',
  'text-align',
  'text-align-last',
  'text-justify',
  'text-shadow',
  'text-emphasis-color',
  'text-emphasis-position',
  'text-emphasis-style',
  'text-underline-position',
  'tab-size',
  'white-space',
  'word-break',
  'overflow-wrap',
  'word-spacing',
  'hyphens',
  'line-break',

  // Writing / bidi
  'direction',
  'unicode-bidi',
  'writing-mode',
  'text-orientation',
  'text-combine-upright',

  // Lists
  'list-style',
  'list-style-image',
  'list-style-position',
  'list-style-type',

  // Tables
  'border-collapse',
  'border-spacing',
  'caption-side',
  'empty-cells',

  // Visibility / interaction
  'cursor',
  'visibility',
  'pointer-events',
  'user-select',

  // Quotes & pagination
  'quotes',
  'orphans',
  'widows',

  // SVG
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'paint-order',
  'shape-rendering',
  'image-rendering',
  'color-interpolation',
  'color-interpolation-filters',
  'color-rendering',
  'dominant-baseline',
  'alignment-baseline',
  'baseline-shift',
  'text-anchor',
  'stop-color',
  'stop-opacity',
  'flood-color',
  'flood-opacity',
  'lighting-color',
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
]);

export function isInheritableProperty(property: string): boolean {
  const p = String(property || '').trim();
  if (!p) return false;
  if (p.startsWith('--')) return true;
  return INHERITED_PROPERTIES.has(p.toLowerCase());
}
