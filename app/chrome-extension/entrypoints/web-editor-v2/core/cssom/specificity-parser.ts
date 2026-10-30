/**
 * CSS Selectors Level 4 specificity computation (IMP-0046 slice 4).
 *
 * Implements the spec for hand-rolled selectors: ID/class/type counts plus
 * the special handling for `:is/:not/:has` (max of arg list), `:where`
 * (always 0), `:nth-child(... of S)`, `::slotted`, and the legacy
 * single-colon pseudo-elements that browsers still tolerate.
 *
 * Pure functions over selector strings — no DOM, no CSSOM. The
 * orchestrator imports computeMatchedRuleSpecificity to walk a selector
 * list against an Element via .matches() and pick the best match.
 */
import type { Specificity } from '../cssom-styles-collector';
import {
  compareEditorSpecificity,
  computeEditorSpecificity,
  selectEditorMatchedSpecificity,
  splitEditorSelectorList,
} from 'humanchrome-shared';



export function compareSpecificity(a: Specificity, b: Specificity): number {
  return compareEditorSpecificity(a, b);
}

export function splitSelectorList(input: string): string[] {
  return splitEditorSelectorList(input);
}


export function computeSelectorSpecificity(selector: string): Specificity {
  return computeEditorSpecificity(selector);
}

/**
 * For a selector list, returns the matched selector with max specificity
 * among matches. Invalid selectors (e.g., pseudo-element pseudos that
 * .matches() throws on) are silently skipped.
 */
export function computeMatchedRuleSpecificity(
  element: Element,
  selectorText: string,
): { matchedSelector: string; specificity: Specificity } | null {
  const matched = splitSelectorList(selectorText).filter((selector) => {
    try {
      return element.matches(selector);
    } catch {
      // Invalid selectors and pseudo-elements retain the existing best-effort DOM behavior.
      return false;
    }
  });
  const selected = selectEditorMatchedSpecificity(matched);
  return selected
    ? { matchedSelector: matched[selected.index], specificity: selected.specificity }
    : null;
}
