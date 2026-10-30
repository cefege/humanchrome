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

import { selectorPolicy } from 'humanchrome-shared';

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

/**
 * Parse a prefixed selector through the shared Rust policy kernel.
 *
 * Composite handling, prefix grammar, exact shorthand, and role parsing are all portable policy;
 * DOM resolution remains with the locator host.
 */
export function parsePrefixedSelector(input: string): ParsedPrefixedSelector {
  return selectorPolicy.parseRustPrefixedSelector(String(input || ''));
}
