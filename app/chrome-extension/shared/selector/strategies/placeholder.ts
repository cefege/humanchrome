/**
 * Placeholder Strategy — Playwright `getByPlaceholder(text)` parity.
 *
 * Resolves <input> / <textarea> elements by their `placeholder` attribute.
 *
 * Strict match: any element with `placeholder` containing the supplied text
 * (case-insensitive by default; pass `exact: true` for case-sensitive
 * equality after whitespace normalization).
 */

import type { SelectorCandidate, SelectorStrategy, NameExactMode } from '../types';
import { matchesAccessibleName } from '../accessible-name';

export function resolveByPlaceholder(
  scope: ParentNode,
  text: string,
  exact?: NameExactMode,
): Element[] {
  const target = String(text || '').trim();
  if (!target) return [];
  const mode = exact ? 'exact' : 'contains';

  const out: Element[] = [];
  const candidates = scope.querySelectorAll('input[placeholder], textarea[placeholder]');
  for (const el of Array.from(candidates)) {
    const placeholder = el.getAttribute('placeholder') ?? '';
    if (matchesAccessibleName(placeholder, target, mode)) out.push(el);
  }
  return out;
}

export const placeholderStrategy: SelectorStrategy & {
  resolve: (value: string, scope: ParentNode, extras?: { exact?: NameExactMode }) => Element[];
} = {
  id: 'placeholder',

  generate(ctx) {
    const { element } = ctx;
    const tag = element.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return [];
    const placeholder = element.getAttribute('placeholder');
    if (!placeholder || !placeholder.trim()) return [];
    const out: SelectorCandidate[] = [
      {
        type: 'placeholder',
        text: placeholder.trim(),
        value: placeholder.trim(),
        source: 'generated',
        strategy: 'placeholder',
      },
    ];
    return out;
  },

  resolve(value, scope, extras) {
    return resolveByPlaceholder(scope, value, extras?.exact);
  },
};

/**
 * Recorder-only projection of placeholders. The emitted attr selector and
 * weight are part of the persisted recording compatibility contract.
 */
export const recorderPlaceholderStrategy: SelectorStrategy = {
  id: 'placeholder',

  generate(ctx) {
    const { element, helpers } = ctx;
    const tag = (element.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return [];

    const raw = element.getAttribute('placeholder');
    const placeholder = raw ? raw.trim() : '';
    if (!placeholder) return [];

    const escaped = helpers.cssEscape(placeholder);
    const attrOnly = `[placeholder="${escaped}"]`;
    const withTag = `${tag}[placeholder="${escaped}"]`;
    const value = helpers.isUnique(attrOnly)
      ? attrOnly
      : helpers.isUnique(withTag)
        ? withTag
        : undefined;
    if (!value) return [];

    return [
      {
        type: 'attr',
        value,
        weight: 25,
        source: 'generated',
        strategy: 'placeholder',
      },
    ];
  },
};
