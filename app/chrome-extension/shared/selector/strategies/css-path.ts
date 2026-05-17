/**
 * CSS Path Strategy - generates a full CSS path using nth-of-type
 *
 * This is the structural last-resort. It always produces a selector, but the
 * nth-of-type ladder is the most brittle locator we can emit (re-ordering a
 * sibling node breaks it). The negative weight pushes it below every other
 * strategy in the priority ladder so it is only chosen when nothing else
 * yields a candidate.
 */

import type { SelectorCandidate, SelectorStrategy } from '../types';

/**
 * Weight penalty: rank below anchor-relpath (-10) and text (-20).
 * css-path is the absolute last resort.
 */
const CSS_PATH_STRATEGY_WEIGHT = -30;

export const cssPathStrategy: SelectorStrategy = {
  id: 'css-path',
  generate(ctx) {
    if (!ctx.options.includeCssPath) return [];

    const { element } = ctx;

    const segments: string[] = [];
    let current: Element | null = element;

    while (current) {
      const tag = current.tagName?.toLowerCase?.() ?? '';
      if (!tag) break;

      let segment = tag;

      const parent: HTMLElement | null = current.parentElement;
      if (parent) {
        const siblings: Element[] = Array.from(parent.children).filter(
          (c: Element) => c.tagName === current!.tagName,
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          if (index > 0) segment += `:nth-of-type(${index})`;
        }
      }

      segments.unshift(segment);

      if (tag === 'body') break;
      current = parent;
    }

    const selector = segments.length ? segments.join(' > ') : 'body';

    const out: SelectorCandidate[] = [
      {
        type: 'css',
        value: selector,
        weight: CSS_PATH_STRATEGY_WEIGHT,
        source: 'generated',
        strategy: 'css-path',
      },
    ];
    return out;
  },
};
