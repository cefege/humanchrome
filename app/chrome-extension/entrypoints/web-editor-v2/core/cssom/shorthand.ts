/**
 * CSS shorthand → longhand expansion (IMP-0046 slice 2).
 *
 * Curated mapping for the shorthands the cascade engine needs to track when
 * computing per-property override status. Custom properties (--foo) and
 * unknown property names pass through unchanged via expandToLonghands.
 *
 * Pure data + one lookup function. Side-effect-free.
 */

export const SHORTHAND_TO_LONGHANDS: Record<string, readonly string[]> = {
  // Spacing
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  inset: ['top', 'right', 'bottom', 'left'],

  // Border
  border: [
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
    'border-top-style',
    'border-right-style',
    'border-bottom-style',
    'border-left-style',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
  ],
  'border-width': [
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
  ],
  'border-style': [
    'border-top-style',
    'border-right-style',
    'border-bottom-style',
    'border-left-style',
  ],
  'border-color': [
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
  ],

  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],

  'border-radius': [
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-right-radius',
    'border-bottom-left-radius',
  ],

  outline: ['outline-color', 'outline-style', 'outline-width'],

  // Background
  background: [
    'background-attachment',
    'background-clip',
    'background-color',
    'background-image',
    'background-origin',
    'background-position',
    'background-repeat',
    'background-size',
  ],

  // Font
  font: [
    'font-style',
    'font-variant',
    'font-weight',
    'font-stretch',
    'font-size',
    'line-height',
    'font-family',
  ],

  // Flexbox
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],

  // Alignment
  'place-content': ['align-content', 'justify-content'],
  'place-items': ['align-items', 'justify-items'],
  'place-self': ['align-self', 'justify-self'],

  // Gaps
  gap: ['row-gap', 'column-gap'],
  'grid-gap': ['row-gap', 'column-gap'],

  // Overflow
  overflow: ['overflow-x', 'overflow-y'],

  // Grid
  'grid-area': ['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end'],
  'grid-row': ['grid-row-start', 'grid-row-end'],
  'grid-column': ['grid-column-start', 'grid-column-end'],
  'grid-template': ['grid-template-rows', 'grid-template-columns', 'grid-template-areas'],

  // Text
  'text-emphasis': ['text-emphasis-style', 'text-emphasis-color'],
  'text-decoration': [
    'text-decoration-line',
    'text-decoration-style',
    'text-decoration-color',
    'text-decoration-thickness',
  ],

  // Animations / transitions
  transition: [
    'transition-property',
    'transition-duration',
    'transition-timing-function',
    'transition-delay',
  ],
  animation: [
    'animation-name',
    'animation-duration',
    'animation-timing-function',
    'animation-delay',
    'animation-iteration-count',
    'animation-direction',
    'animation-fill-mode',
    'animation-play-state',
  ],

  // Multi-column
  columns: ['column-width', 'column-count'],
  'column-rule': ['column-rule-width', 'column-rule-style', 'column-rule-color'],

  // Lists
  'list-style': ['list-style-position', 'list-style-image', 'list-style-type'],
};

export function expandToLonghands(property: string): readonly string[] {
  const raw = String(property || '').trim();
  if (!raw) return [];
  if (raw.startsWith('--')) return [raw];
  const p = raw.toLowerCase();
  return SHORTHAND_TO_LONGHANDS[p] ?? [p];
}
