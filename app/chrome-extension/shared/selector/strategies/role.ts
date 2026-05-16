/**
 * Role Strategy — Playwright `getByRole(role, { name })` parity.
 *
 * Resolves elements by implicit or explicit ARIA role plus accessible name.
 *
 * Implicit roles supported (hand-rolled — no aria-query dep):
 *
 *   button     <button>, <input type="button|submit|reset">, <summary>
 *   link       <a href>, <area href>
 *   textbox    <input type="text|email|tel|url|search|password" (no list)>,
 *              <textarea>
 *   searchbox  <input type="search">
 *   checkbox   <input type="checkbox">
 *   radio      <input type="radio">
 *   combobox   <select> (single), <input list=...>
 *   listbox    <select multiple>, <select size>=2
 *   option     <option>
 *   menuitem   (no implicit — explicit role only)
 *   tab        (no implicit — explicit role only)
 *   heading    <h1>..<h6>
 *   img        <img alt!=""> (alt="" makes it role="presentation")
 *   list       <ul>, <ol>, <dl>
 *   listitem   <li> (only when ancestor is ul/ol)
 *   navigation <nav>
 *   main       <main>
 *   banner     <header> (only when not inside section/article)
 *   contentinfo<footer> (only when not inside section/article)
 *   region     <section> (only with accessible name)
 *   article    <article>
 *   complementary <aside>
 *   form       <form> (only with accessible name)
 *   table      <table>
 *   row        <tr>
 *   cell       <td>
 *   columnheader <th scope=col> or <th> in thead
 *   rowheader  <th scope=row>
 *   dialog     <dialog>
 *   separator  <hr>
 *
 * Explicit role (role="...") always wins over implicit. Multiple roles
 * (role="button menuitem") are treated as a single explicit role only —
 * IMP-0098 deliberately doesn't implement the full role-cascade rules.
 */

import type { SelectorCandidate, SelectorStrategy, NameExactMode } from '../types';
import { computeAccessibleName, matchesAccessibleName } from '../accessible-name';

// =============================================================================
// Role inference (subset of ARIA in HTML)
// =============================================================================

const TEXTBOX_INPUT_TYPES = new Set(['text', 'email', 'tel', 'url', 'password']);

/**
 * Best-effort implicit-role lookup for a single element. Returns undefined
 * for elements with no implicit role (e.g. <div>) so callers can skip them.
 */
export function getImplicitRole(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();

  switch (tag) {
    case 'a':
    case 'area':
      return el.hasAttribute('href') ? 'link' : undefined;
    case 'button':
      return 'button';
    case 'summary':
      return 'button';
    case 'input':
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image')
        return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'hidden' || type === 'file' || type === 'color') return undefined;
      if (el.hasAttribute('list')) return 'combobox';
      if (TEXTBOX_INPUT_TYPES.has(type) || type === '') return 'textbox';
      return 'textbox';
    case 'textarea':
      return 'textbox';
    case 'select': {
      if (el.hasAttribute('multiple')) return 'listbox';
      const size = Number(el.getAttribute('size') || '0');
      if (size > 1) return 'listbox';
      return 'combobox';
    }
    case 'option':
      return 'option';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'img':
      // Per WAI-ARIA, <img alt=""> is role="presentation" (not "img"). Only
      // images with a non-empty alt or no alt at all are exposed as `img`.
      return el.getAttribute('alt') === '' ? undefined : 'img';
    case 'ul':
    case 'ol':
    case 'dl':
      return 'list';
    case 'li':
      return 'listitem';
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'header':
      // banner only when not inside <article>/<aside>/<main>/<nav>/<section>
      return isLandmarkContext(el) ? undefined : 'banner';
    case 'footer':
      return isLandmarkContext(el) ? undefined : 'contentinfo';
    case 'section':
      // region role only when the section has an accessible name.
      return computeAccessibleName(el) ? 'region' : undefined;
    case 'article':
      return 'article';
    case 'aside':
      return 'complementary';
    case 'form':
      return computeAccessibleName(el) ? 'form' : undefined;
    case 'table':
      return 'table';
    case 'tr':
      return 'row';
    case 'td':
      return 'cell';
    case 'th': {
      const scope = (el.getAttribute('scope') || '').toLowerCase();
      if (scope === 'row') return 'rowheader';
      if (scope === 'col') return 'columnheader';
      const parent = el.parentElement;
      if (parent?.parentElement?.tagName?.toLowerCase() === 'thead') return 'columnheader';
      return 'cell';
    }
    case 'dialog':
      return 'dialog';
    case 'hr':
      return 'separator';
    case 'progress':
      return 'progressbar';
    case 'meter':
      return 'meter';
    default:
      return undefined;
  }
}

function isLandmarkContext(el: Element): boolean {
  let p: Element | null = el.parentElement;
  while (p) {
    const t = p.tagName.toLowerCase();
    if (t === 'article' || t === 'aside' || t === 'main' || t === 'nav' || t === 'section')
      return true;
    p = p.parentElement;
  }
  return false;
}

/**
 * Computed role — explicit role attribute first, falling back to the implicit
 * mapping above. When `role="button menuitem"` is supplied, only the first
 * token is honored (matches Playwright behavior; full role-cascade rules are
 * out of scope for IMP-0098).
 */
export function getElementRole(el: Element): string | undefined {
  const explicit = el.getAttribute('role');
  if (explicit) {
    const first = explicit.split(/\s+/)[0];
    if (first) return first.toLowerCase();
  }
  return getImplicitRole(el);
}

// =============================================================================
// Strategy
// =============================================================================

/**
 * Resolve elements matching `role` (with optional accessible `name`).
 *
 * Returns the full match set; callers apply strict-mode / index selection.
 */
export function resolveByRole(
  scope: ParentNode,
  role: string,
  name?: string,
  exact?: NameExactMode,
): Element[] {
  const targetRole = role.trim().toLowerCase();
  if (!targetRole) return [];

  const out: Element[] = [];
  const walker = (scope.ownerDocument ?? document).createTreeWalker(
    scope as Node,
    NodeFilter.SHOW_ELEMENT,
  );
  let node: Node | null = walker.currentNode;
  // TreeWalker starts on `scope` itself — include it in the walk only when
  // it's also an element.
  if (scope instanceof Element) {
    if (getElementRole(scope) === targetRole) {
      if (
        !name ||
        matchesAccessibleName(computeAccessibleName(scope), name, exact ? 'exact' : 'contains')
      ) {
        out.push(scope);
      }
    }
  }
  while ((node = walker.nextNode())) {
    if (!(node instanceof Element)) continue;
    const r = getElementRole(node);
    if (r !== targetRole) continue;
    if (name) {
      const computed = computeAccessibleName(node);
      if (!matchesAccessibleName(computed, name, exact ? 'exact' : 'contains')) continue;
    }
    out.push(node);
  }
  return out;
}

export const roleStrategy: SelectorStrategy & {
  resolve: (
    value: string,
    scope: ParentNode,
    extras?: { role?: string; name?: string; exact?: NameExactMode },
  ) => Element[];
} = {
  id: 'role',

  generate(ctx) {
    const { element } = ctx;
    const role = getElementRole(element);
    if (!role) return [];

    const name = computeAccessibleName(element);
    const out: SelectorCandidate[] = [];

    out.push({
      type: 'role',
      role,
      name: name || undefined,
      value: name ? `${role}[name=${JSON.stringify(name)}]` : role,
      source: 'generated',
      strategy: 'role',
    });

    return out;
  },

  /**
   * Resolve a role-based selector. Accepts either a parsed `{role,name,exact}`
   * triple (preferred — produced by `parseRoleSelector`) or the legacy serialized
   * form `role[name="..."]` for backwards compat with stored candidates.
   */
  resolve(value, scope, extras) {
    const parsed = extras?.role
      ? { role: extras.role, name: extras.name, exact: extras.exact }
      : parseRoleSelector(value);
    if (!parsed.role) return [];
    return resolveByRole(scope, parsed.role, parsed.name, parsed.exact);
  },
};

// =============================================================================
// Parser
// =============================================================================

/**
 * Parse a `role[name="...",exact=true]` selector value into its parts.
 *
 * Accepts:
 *   "button"                                — role only
 *   "button[name=\"Submit\"]"               — role + name (contains by default)
 *   "button[name=\"Submit\",exact=true]"    — role + exact name match
 *
 * The format mirrors the structured form emitted by `generate()`.
 */
export function parseRoleSelector(value: string): {
  role?: string;
  name?: string;
  exact?: boolean;
} {
  const v = String(value || '').trim();
  if (!v) return {};
  // Quick path — bare role.
  const bare = v.match(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
  if (bare) return { role: v.toLowerCase() };

  const match = v.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*\[\s*(.+?)\s*\]$/);
  if (!match) return {};
  const role = match[1].toLowerCase();
  const body = match[2];

  // Split on commas not inside quotes.
  const tokens: string[] = [];
  let cur = '';
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  for (const ch of body) {
    if (inStr) {
      cur += ch;
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      cur += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      tokens.push(cur);
      cur = '';
      continue;
    }
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    cur += ch;
  }
  if (cur) tokens.push(cur);

  let name: string | undefined;
  let exact: boolean | undefined;
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq === -1) continue;
    const k = tok.slice(0, eq).trim().toLowerCase();
    let raw = tok.slice(eq + 1).trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1);
    }
    if (k === 'name') name = raw;
    if (k === 'exact') exact = raw === 'true' || raw === '1';
  }
  return { role, name, exact };
}
