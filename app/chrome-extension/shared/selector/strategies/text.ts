/**
 * Text Strategy - Text content based selector strategy.
 *
 * For interactive tags (button/a/summary), visible text is a Playwright-style
 * first-class locator (`getByText`). Rust assigns its generated-candidate
 * priority after this DOM strategy has collected the text.
 */

import type { SelectorCandidate, SelectorStrategy } from '../types';

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
        source: 'generated',
        strategy: 'text',
      },
    ];
  },
};
