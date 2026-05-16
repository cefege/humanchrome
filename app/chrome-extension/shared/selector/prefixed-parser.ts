/**
 * Prefixed selector parser — turns strings like
 *   role:button[name="Submit",exact=true]
 *   label:Email
 *   placeholder:Search
 *   alt:Logo
 *   title:Close
 *   testid:submit-btn
 *   text:Login
 *   css:body > .foo
 *   xpath://button[1]
 *
 * into a structured `ParsedPrefixedSelector` that the locator can dispatch
 * to the right runtime branch.
 *
 * Composite selectors continue to use the `|>` separator (iframe traversal),
 * applied AFTER prefix detection so:
 *   "iframe#payment |> role:button[name=\"Pay\"]"
 * resolves the iframe first, then runs the inner prefix selector inside.
 *
 * Strings without a known prefix fall through as plain CSS (legacy behavior).
 */

import { parseRoleSelector } from './strategies/role';
import { isCompositeSelector } from './types';

export type PrefixedSelectorKind =
  | 'css'
  | 'xpath'
  | 'role'
  | 'label'
  | 'placeholder'
  | 'alt'
  | 'title'
  | 'testid'
  | 'text';

export interface ParsedPrefixedSelector {
  kind: PrefixedSelectorKind;
  /** Raw value after the prefix (e.g. `button[name="Submit"]` for role). */
  value: string;
  /** Extracted name (role only). */
  name?: string;
  /** Extracted role (role only — duplicated for convenience). */
  role?: string;
  /** Exact-match flag (role / label / placeholder / alt / title / text). */
  exact?: boolean;
  /** Original input string (debug / re-emit). */
  raw: string;
}

const KNOWN_PREFIXES = new Set<PrefixedSelectorKind>([
  'css',
  'xpath',
  'role',
  'label',
  'placeholder',
  'alt',
  'title',
  'testid',
  'text',
]);

/**
 * Parse a prefixed selector. Composite (`|>`-separated) selectors are
 * returned as-is in `value` with `kind: 'css'` — callers split composites
 * before dispatching to this parser.
 */
export function parsePrefixedSelector(input: string): ParsedPrefixedSelector {
  const raw = String(input || '');
  // Composite shortcut — caller already handles iframe split; this parser
  // operates on the inner segment.
  if (isCompositeSelector(raw)) {
    return { kind: 'css', value: raw, raw };
  }

  // Prefix detection — match `kind:rest`. The prefix must be a known token
  // and must be followed by a colon (no whitespace).
  const colon = raw.indexOf(':');
  if (colon > 0 && colon < raw.length - 1) {
    const possiblePrefix = raw.slice(0, colon).trim().toLowerCase();
    if (KNOWN_PREFIXES.has(possiblePrefix as PrefixedSelectorKind)) {
      const kind = possiblePrefix as PrefixedSelectorKind;
      const value = raw.slice(colon + 1).trim();
      const parsed: ParsedPrefixedSelector = { kind, value, raw };

      if (kind === 'role') {
        const r = parseRoleSelector(value);
        parsed.role = r.role;
        parsed.name = r.name;
        parsed.exact = r.exact;
      } else if (
        kind === 'label' ||
        kind === 'placeholder' ||
        kind === 'alt' ||
        kind === 'title' ||
        kind === 'text'
      ) {
        // For these kinds we accept `text` or `text@exact` shorthand to opt
        // into exact-match. Keeping the syntax minimal — full bracket syntax
        // is reserved for the role parser.
        const at = value.lastIndexOf('@exact');
        if (at !== -1 && at === value.length - '@exact'.length) {
          parsed.value = value.slice(0, at).trim();
          parsed.exact = true;
        }
      }

      return parsed;
    }
  }

  // No known prefix — treat as CSS (legacy behavior).
  return { kind: 'css', value: raw, raw };
}
