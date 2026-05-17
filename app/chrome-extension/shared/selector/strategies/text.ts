/**
 * Text Strategy - Text content based selector strategy
 *
 * For interactive tags (button/a/summary), the visible text is a
 * Playwright-style first-class locator (`getByText`). The recorder treats
 * this as a high-priority candidate when the text is short enough to be
 * stable (≤ 64 chars by default).
 *
 * Weight (+10) ranks text below all semantic-attribute strategies
 * (testid/aria/label/placeholder/alt/title) but ABOVE css-unique so that
 * a "Sign in" button records as `text="Sign in"` rather than
 * `.sign-in-btn` — surviving CSS class renames.
 */

import type { SelectorCandidate, SelectorStrategy } from '../types';

/**
 * Weight: ranks below all semantic-attribute strategies (testid +50,
 * aria +40, label +30, placeholder +25, alt/title from testid +20/+18)
 * but ABOVE css-unique (default 0). Text is more durable than a CSS
 * class for tags like button/link.
 */
const TEXT_STRATEGY_WEIGHT = 10;

function normalizeText(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const textStrategy: SelectorStrategy = {
  id: 'text',

  generate(ctx) {
    if (!ctx.options.includeText) return [];

    const { element, options } = ctx;
    const tag = element.tagName?.toLowerCase?.() ?? '';
    if (!tag || !options.textTags.includes(tag)) return [];

    const raw = element.textContent || '';
    const text = normalizeText(raw).slice(0, options.textMaxLength);
    if (!text) return [];

    return [
      {
        type: 'text',
        value: text,
        match: 'contains',
        tagNameHint: tag,
        weight: TEXT_STRATEGY_WEIGHT,
        source: 'generated',
        strategy: 'text',
      },
    ];
  },
};
