/**
 * Title Strategy — Playwright `getByTitle(text)` parity.
 *
 * Resolves any element by its `title` attribute. Most often used for icon
 * buttons or tooltips.
 */

import type { SelectorCandidate, SelectorStrategy, NameExactMode } from '../types';
import { matchesAccessibleName } from '../accessible-name';

export function resolveByTitle(scope: ParentNode, text: string, exact?: NameExactMode): Element[] {
  const target = String(text || '').trim();
  if (!target) return [];
  const mode = exact ? 'exact' : 'contains';

  const out: Element[] = [];
  const candidates = scope.querySelectorAll('[title]');
  for (const el of Array.from(candidates)) {
    const title = el.getAttribute('title') ?? '';
    if (matchesAccessibleName(title, target, mode)) out.push(el);
  }
  return out;
}

export const titleStrategy: SelectorStrategy & {
  resolve: (value: string, scope: ParentNode, extras?: { exact?: NameExactMode }) => Element[];
} = {
  id: 'title',

  generate(ctx) {
    const { element } = ctx;
    const title = element.getAttribute('title');
    if (!title || !title.trim()) return [];
    const out: SelectorCandidate[] = [
      {
        type: 'title',
        text: title.trim(),
        value: title.trim(),
        source: 'generated',
        strategy: 'title',
      },
    ];
    return out;
  },

  resolve(value, scope, extras) {
    return resolveByTitle(scope, value, extras?.exact);
  },
};
