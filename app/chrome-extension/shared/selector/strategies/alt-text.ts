/**
 * Alt-Text Strategy — Playwright `getByAltText(text)` parity.
 *
 * Resolves <img>, <area>, and <input type="image"> by their `alt` attribute.
 *
 * Match is case-insensitive substring by default; `exact: true` switches to
 * normalized equality.
 */

import type { SelectorCandidate, SelectorStrategy, NameExactMode } from '../types';
import { matchesAccessibleName } from '../accessible-name';

const ALT_TAGS = new Set(['img', 'area']);

function hasAlt(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (ALT_TAGS.has(tag)) return el.hasAttribute('alt');
  if (tag === 'input') return (el.getAttribute('type') || '').toLowerCase() === 'image';
  return false;
}

export function resolveByAltText(
  scope: ParentNode,
  text: string,
  exact?: NameExactMode,
): Element[] {
  const target = String(text || '').trim();
  if (!target) return [];
  const mode = exact ? 'exact' : 'contains';

  const out: Element[] = [];
  const candidates = scope.querySelectorAll('img[alt], area[alt], input[type="image"][alt]');
  for (const el of Array.from(candidates)) {
    const alt = el.getAttribute('alt') ?? '';
    if (matchesAccessibleName(alt, target, mode)) out.push(el);
  }
  return out;
}

export const altTextStrategy: SelectorStrategy & {
  resolve: (value: string, scope: ParentNode, extras?: { exact?: NameExactMode }) => Element[];
} = {
  id: 'alt-text',

  generate(ctx) {
    const { element } = ctx;
    if (!hasAlt(element)) return [];
    const alt = element.getAttribute('alt');
    if (!alt || !alt.trim()) return [];
    const out: SelectorCandidate[] = [
      {
        type: 'alt',
        text: alt.trim(),
        value: alt.trim(),
        source: 'generated',
        strategy: 'alt-text',
      },
    ];
    return out;
  },

  resolve(value, scope, extras) {
    return resolveByAltText(scope, value, extras?.exact);
  },
};
