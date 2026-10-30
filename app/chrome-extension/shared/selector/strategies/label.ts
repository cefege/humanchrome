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
import { computeAccessibleName, matchesAccessibleName, LABELLABLE_TAGS } from '../accessible-name';

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

function recorderRoleForFormTag(tag: string, element: Element): string | undefined {
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (tag !== 'input') return undefined;

  const type = (element.getAttribute('type') || 'text').toLowerCase();
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
  if (type === 'range') return 'slider';
  if (type === 'search') return 'searchbox';
  return 'textbox';
}

function normalizeRecorderLabelWhitespace(value: string | null | undefined): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readRecorderLabelText(element: Element): string {
  const innerText = (element as HTMLElement).innerText;
  return normalizeRecorderLabelWhitespace(
    typeof innerText === 'string' ? innerText : element.textContent || '',
  );
}

function findRecorderLabelText(
  element: Element,
  cssEscape: (value: string) => string,
): string | null {
  const labelledByRaw = element.getAttribute('aria-labelledby');
  const labelledBy = labelledByRaw ? labelledByRaw.trim() : '';
  if (labelledBy) {
    const root = element.getRootNode?.() ?? document;
    const ids = labelledBy.split(/\s+/).filter(Boolean);
    const parts: string[] = [];
    for (const id of ids) {
      try {
        const ref =
          typeof (root as Document).getElementById === 'function'
            ? (root as Document).getElementById(id)
            : (root as ParentNode).querySelector?.(`#${cssEscape(id)}`);
        if (ref) {
          const text = readRecorderLabelText(ref);
          if (text) parts.push(text);
        }
      } catch {
        // Keep the recorder's best-effort DOM lookup behavior.
      }
    }
    const joined = parts.join(' ').trim();
    if (joined) return joined;
  }

  const idRaw = element.id;
  const id = idRaw ? String(idRaw).trim() : '';
  if (id) {
    try {
      const root = element.getRootNode?.() ?? document;
      const label = (root as ParentNode).querySelector?.(`label[for="${cssEscape(id)}"]`);
      if (label) {
        const text = readRecorderLabelText(label);
        if (text) return text;
      }
    } catch {
      // Keep the recorder's best-effort DOM lookup behavior.
    }
  }

  try {
    let cursor = element.parentElement;
    let depth = 0;
    while (cursor && depth < 6) {
      if ((cursor.tagName || '').toLowerCase() === 'label') {
        const clone = cursor.cloneNode(true) as Element;
        try {
          clone.querySelectorAll('input,textarea,select,button').forEach((node) => node.remove());
        } catch {
          // A malformed DOM adapter must not prevent selector generation.
        }
        const text = readRecorderLabelText(clone);
        if (text) return text;
        break;
      }
      cursor = cursor.parentElement;
      depth += 1;
    }
  } catch {
    // Keep the recorder's best-effort DOM lookup behavior.
  }

  return null;
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

/**
 * Recorder-only DOM extraction compatible with the frozen eight-strategy
 * selector engine. Candidate ranking, deduplication, and weights remain Rust-owned.
 */
export const recorderLabelStrategy: SelectorStrategy = {
  id: 'label',

  generate(ctx) {
    if (!ctx.options.includeAria) return [];

    const { element, helpers } = ctx;
    const tag = (element.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return [];

    const ariaLabelRaw = element.getAttribute('aria-label');
    if (ariaLabelRaw && ariaLabelRaw.trim()) return [];

    const name = findRecorderLabelText(element, helpers.cssEscape);
    if (!name) return [];

    const role = recorderRoleForFormTag(tag, element);
    return [
      {
        type: 'aria',
        value: `${role || 'element'}[name=${JSON.stringify(name)}]`,
        role,
        name,
        source: 'generated',
        strategy: 'label',
      },
    ];
  },
};
