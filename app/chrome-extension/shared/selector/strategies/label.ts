/**
 * Label Strategy — Playwright `getByLabel(text)` parity.
 *
 * Resolves form controls (input, textarea, select, button, output, meter,
 * progress) by their associated label text. The label can be:
 *
 *   1. label[for=controlId] — explicit association
 *   2. <label><input></label> — wrapping
 *   3. aria-labelledby pointing at an element whose text matches
 *   4. aria-label attribute matching
 *
 * Cases 3 + 4 piggy-back on `computeAccessibleName` so the matching semantics
 * stay consistent across getByLabel and getByRole calls.
 */

import type { SelectorCandidate, SelectorStrategy, NameExactMode } from '../types';
import { computeAccessibleName, matchesAccessibleName } from '../accessible-name';

const LABELLABLE_TAGS = new Set([
  'input',
  'textarea',
  'select',
  'button',
  'output',
  'progress',
  'meter',
]);

/**
 * Find every labellable control whose computed label (or accessible name)
 * matches `text` per Playwright getByLabel semantics.
 */
export function resolveByLabel(scope: ParentNode, text: string, exact?: NameExactMode): Element[] {
  const out: Element[] = [];
  const mode = exact ? 'exact' : 'contains';
  const target = String(text || '').trim();
  if (!target) return [];

  const doc = scope.ownerDocument ?? document;
  const walker = doc.createTreeWalker(scope as Node, NodeFilter.SHOW_ELEMENT);

  if (scope instanceof Element) checkOne(scope);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node instanceof Element) checkOne(node);
  }

  function checkOne(el: Element): void {
    const tag = el.tagName.toLowerCase();
    if (!LABELLABLE_TAGS.has(tag)) return;

    // Type-hidden inputs aren't labellable in any meaningful UI sense.
    if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') return;

    // Fast path — control's accessible name (covers aria-label,
    // aria-labelledby, label[for], wrapping label).
    const name = computeAccessibleName(el);
    if (name && matchesAccessibleName(name, target, mode)) {
      out.push(el);
      return;
    }
  }

  return out;
}

export const labelStrategy: SelectorStrategy & {
  resolve: (value: string, scope: ParentNode, extras?: { exact?: NameExactMode }) => Element[];
} = {
  id: 'label',

  generate(ctx) {
    const { element } = ctx;
    const tag = element.tagName.toLowerCase();
    if (!LABELLABLE_TAGS.has(tag)) return [];

    const name = computeAccessibleName(element);
    if (!name) return [];

    const out: SelectorCandidate[] = [
      {
        type: 'label',
        text: name,
        value: name,
        source: 'generated',
        strategy: 'label',
      },
    ];
    return out;
  },

  resolve(value, scope, extras) {
    return resolveByLabel(scope, value, extras?.exact);
  },
};
