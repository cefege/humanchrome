/**
 * Accessible-Name compute - subset of W3C Accessible Name and Description Computation 1.2
 *
 * Spec: https://www.w3.org/TR/accname-1.2/
 *
 * This module implements a *practical subset* of accname-1.2 sufficient for
 * Playwright-style locator resolution (`getByRole`, `getByLabel`, etc.). It is
 * NOT a full implementation — the omissions are documented at the call sites.
 *
 * Implemented (per §4.3 Text Alternative Computation):
 *   - Step 2A: aria-labelledby chain (id refs joined by space, recursive)
 *   - Step 2B: aria-label
 *   - Step 2C: native host language label (label[for], wrapping label,
 *              <input type=submit|button|reset> value, <img alt>, <area alt>,
 *              <fieldset><legend>, <table><caption>, summary contents)
 *   - Step 2D: tooltip (title attribute)
 *   - Step 2F: name from content (recurses into descendants for elements
 *              whose role allows "name from content" — buttons, links,
 *              headings, options, menuitems, etc.)
 *
 * Deliberately skipped (gated by "// SKIP-ACCNAME-CSS" comments):
 *   - §4.3.2 CSS pseudo-element ::before / ::after content (skipped per
 *     IMP-0098 sketch — adds DOM cost for marginal locator wins).
 *   - Step 2E (placeholder fallback) — exposed separately via `placeholder.ts`
 *     to keep locator semantics predictable. Mixing placeholder into name
 *     made tests order-dependent.
 *   - aria-description / aria-describedby — these compute the *description*,
 *     not the name. Out of scope.
 *
 * The implementation is pure-DOM (works in jsdom and the live page). No
 * Chrome APIs, no async. Cycle-detection uses a visited Set keyed on element
 * identity to handle aria-labelledby self-references.
 */

const MAX_NAME_LENGTH = 1024;

interface ComputeOptions {
  /**
   * Elements already visited in the current chain — prevents infinite
   * recursion through aria-labelledby cycles. Callers should not pass this;
   * it's an internal recursion guard.
   */
  visited?: WeakSet<Element>;
  /**
   * When true (recursing through aria-labelledby), include hidden text per
   * §4.3.2 step 2A.iii.b. The top-level call omits hidden elements.
   */
  includeHidden?: boolean;
  /**
   * When true (recursing through aria-labelledby OR inside name-from-content),
   * always perform name-from-content traversal even for elements whose
   * implicit role normally wouldn't allow it. Matches §4.3.2 step 2F.iii.
   */
  forceContent?: boolean;
}

/**
 * Roles for which the accessible name MAY come from contents (per ARIA 1.2
 * "Name from contents"). Subset covering the common interactive roles.
 */
const NAME_FROM_CONTENT_ROLES = new Set<string>([
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'gridcell',
  'heading',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'row',
  'rowheader',
  'switch',
  'tab',
  'tooltip',
  'treeitem',
]);

const NAME_FROM_CONTENT_TAGS = new Set<string>([
  'a',
  'button',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'summary',
  'option',
]);

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isHidden(el: Element): boolean {
  // Cheap visibility check — we do NOT call getComputedStyle here because
  // jsdom and live-DOM behave differently and the cost is non-trivial. The
  // attribute path catches the common cases.
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (el.hasAttribute('hidden')) return true;
  return false;
}

/**
 * Per accname §4.3.2 step 2A.iii: when an element has aria-labelledby, the
 * name is the concatenation of computeAccessibleName(refEl) for each id.
 */
function computeFromLabelledBy(
  el: Element,
  ids: string[],
  visited: WeakSet<Element>,
): string | null {
  const root = el.ownerDocument;
  if (!root) return null;
  const parts: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed) continue;
    const ref = root.getElementById(trimmed);
    if (!ref || visited.has(ref)) continue;
    const name = computeAccessibleNameInternal(ref, {
      visited,
      includeHidden: true, // §4.3.2 step 2A.iii.b — hidden text is in scope when traversing labelledby
      // §4.3.2 step 2F.iii: when computing as part of a labelledby ref, name
      // from content applies even to elements (like <span>) whose implicit
      // role wouldn't normally allow it.
      forceContent: true,
    });
    if (name) parts.push(name);
  }
  const out = parts.join(' ').trim();
  return out || null;
}

/**
 * Per §4.3.2 step 2C: native host-language label.
 *
 * Order matters here — `label[for]` outranks wrapping `<label>` so callers
 * get the same answer as the platform accessibility tree.
 */
function nativeHostLabel(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  const id = el.id;

  // label[for=id]
  if (id && el.ownerDocument) {
    // Escape the id for CSS selectors — ids can legally contain colons,
    // brackets, etc. that would break a raw [for="..."] match.
    const escaped = el.ownerDocument.defaultView?.CSS?.escape?.(id) ?? id;
    const explicitLabel = el.ownerDocument.querySelector(`label[for="${escaped}"]`);
    if (explicitLabel) {
      const text = normalize(explicitLabel.textContent || '');
      if (text) return text;
    }
  }

  // Wrapping <label> — only count when the element is one of the
  // labellable types (input, textarea, select, button, output, progress,
  // meter). Per HTML5 §4.10.4.
  if (['input', 'textarea', 'select', 'button', 'output', 'progress', 'meter'].includes(tag)) {
    let current: Element | null = el.parentElement;
    while (current) {
      if (current.tagName.toLowerCase() === 'label') {
        const clone = current.cloneNode(true) as Element;
        // Remove the labelled control itself so we only see the surrounding text
        clone
          .querySelectorAll('input, textarea, select, button, output, progress, meter')
          .forEach((c) => c.remove());
        const text = normalize(clone.textContent || '');
        if (text) return text;
        break;
      }
      current = current.parentElement;
    }
  }

  if (tag === 'input') {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'reset') {
      const value = el.getAttribute('value');
      if (value) return normalize(value);
      // Browser defaults — matches platform behavior.
      if (type === 'submit') return 'Submit';
      if (type === 'reset') return 'Reset';
    }
    if (type === 'image') {
      const alt = el.getAttribute('alt');
      if (alt) return normalize(alt);
    }
  }

  if (tag === 'img' || tag === 'area') {
    const alt = el.getAttribute('alt');
    if (alt !== null) return normalize(alt);
  }

  if (tag === 'fieldset') {
    const legend = el.querySelector(':scope > legend');
    if (legend) {
      const text = normalize(legend.textContent || '');
      if (text) return text;
    }
  }

  if (tag === 'table') {
    const caption = el.querySelector(':scope > caption');
    if (caption) {
      const text = normalize(caption.textContent || '');
      if (text) return text;
    }
  }

  if (tag === 'summary') {
    const text = normalize(el.textContent || '');
    if (text) return text;
  }

  return null;
}

/**
 * §4.3.2 step 2F: name from content.
 *
 * Walks descendants concatenating text-equivalents. For element descendants
 * we recurse through computeAccessibleNameInternal so embedded aria-labelledby
 * /label refs are honored (matches Playwright / Chrome behavior).
 */
function nameFromContent(el: Element, visited: WeakSet<Element>): string {
  const parts: string[] = [];

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3 /* TEXT_NODE */) {
      parts.push(child.textContent || '');
      continue;
    }
    if (child.nodeType !== 1 /* ELEMENT_NODE */) continue;
    const childEl = child as Element;
    if (isHidden(childEl)) continue;

    // Recurse with forceContent so nested non-namable elements (spans, divs)
    // still surface their text. Matches §4.3.2 step 2F.iii.
    const childName = computeAccessibleNameInternal(childEl, { visited, forceContent: true });
    if (childName) {
      parts.push(childName);
    } else {
      // Fallback to text — children that contribute no name still contribute
      // their text content (per §4.3.2 step 2F.i).
      const text = childEl.textContent || '';
      if (text) parts.push(text);
    }
  }

  return normalize(parts.join(' '));
}

function computeAccessibleNameInternal(el: Element, options: ComputeOptions = {}): string {
  if (!el || !el.tagName) return '';
  const visited = options.visited ?? new WeakSet<Element>();
  if (visited.has(el)) return ''; // cycle guard
  visited.add(el);

  if (!options.includeHidden && isHidden(el)) return '';

  // §4.3.2 Step 2A — aria-labelledby (skip if recursing already inside one)
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/);
    const fromLb = computeFromLabelledBy(el, ids, visited);
    if (fromLb) return fromLb.slice(0, MAX_NAME_LENGTH);
  }

  // Step 2B — aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    const trimmed = normalize(ariaLabel);
    if (trimmed) return trimmed.slice(0, MAX_NAME_LENGTH);
  }

  // Step 2C — native host language label
  const native = nativeHostLabel(el);
  if (native) return native.slice(0, MAX_NAME_LENGTH);

  // Step 2F — name from contents, if role allows it (or `forceContent` was
  // set by a recursive caller — labelledby ref / nameFromContent descent).
  const role = el.getAttribute('role')?.toLowerCase();
  const tag = el.tagName.toLowerCase();
  const allowsContent =
    options.forceContent ||
    (role && NAME_FROM_CONTENT_ROLES.has(role)) ||
    NAME_FROM_CONTENT_TAGS.has(tag);

  if (allowsContent) {
    const fromContent = nameFromContent(el, visited);
    if (fromContent) return fromContent.slice(0, MAX_NAME_LENGTH);
  }

  // Step 2D — tooltip (title attribute) as last resort
  const title = el.getAttribute('title');
  if (title) {
    const trimmed = normalize(title);
    if (trimmed) return trimmed.slice(0, MAX_NAME_LENGTH);
  }

  // SKIP-ACCNAME-CSS: §4.3.2 Step 2I CSS pseudo-content. Deliberately omitted
  // per IMP-0098 scope (would require getComputedStyle calls on ::before /
  // ::after for every candidate during locator resolution).

  return '';
}

/**
 * Compute the accessible name of an element per W3C accname-1.2 (subset).
 *
 * @param el The element to compute the name for.
 * @returns Normalized accessible name (whitespace-collapsed, trimmed), or
 *          empty string when the element has none.
 */
export function computeAccessibleName(el: Element | null | undefined): string {
  if (!el) return '';
  return computeAccessibleNameInternal(el, {});
}

/**
 * Whether two accessible-name strings match. The match mode is selected by
 * the caller:
 *
 * - 'exact'    — case-sensitive equality after normalization
 * - 'iexact'   — case-insensitive equality after normalization
 * - 'contains' — case-insensitive substring (the default — matches
 *                Playwright's `getByRole({ name: ... })` behavior)
 * - regex      — caller-supplied regex; tested against the normalized name
 */
export type NameMatchMode = 'exact' | 'iexact' | 'contains';

export function matchesAccessibleName(
  computed: string,
  target: string | RegExp,
  mode: NameMatchMode = 'contains',
): boolean {
  if (target instanceof RegExp) return target.test(computed);
  const a = normalize(computed);
  const b = normalize(target);
  if (!a || !b) return false;
  if (mode === 'exact') return a === b;
  if (mode === 'iexact') return a.toLowerCase() === b.toLowerCase();
  // contains
  return a.toLowerCase().includes(b.toLowerCase());
}
