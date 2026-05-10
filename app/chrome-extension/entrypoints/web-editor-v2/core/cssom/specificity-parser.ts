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

const ZERO_SPEC: Specificity = [0, 0, 0, 0] as const;

export function compareSpecificity(a: Specificity, b: Specificity): number {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

export function splitSelectorList(input: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depthParen = 0;
  let depthBrack = 0;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '\\') {
      i += 1;
      continue;
    }

    if (ch === '[') depthBrack += 1;
    else if (ch === ']' && depthBrack > 0) depthBrack -= 1;
    else if (ch === '(') depthParen += 1;
    else if (ch === ')' && depthParen > 0) depthParen -= 1;

    if (ch === ',' && depthParen === 0 && depthBrack === 0) {
      const part = input.slice(start, i).trim();
      if (part) out.push(part);
      start = i + 1;
    }
  }

  const tail = input.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function maxSpecificity(list: readonly Specificity[]): Specificity {
  let best: Specificity = ZERO_SPEC;
  for (const s of list) if (compareSpecificity(s, best) > 0) best = s;
  return best;
}

const LEGACY_PSEUDO_ELEMENTS = new Set([
  'before',
  'after',
  'first-line',
  'first-letter',
  'selection',
  'backdrop',
  'placeholder',
]);

function isIdentStart(ch: string): boolean {
  return /[a-zA-Z_]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

function consumeIdent(s: string, start: number): number {
  let i = start;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (/[a-zA-Z0-9_-]/.test(ch) || ch.charCodeAt(0) >= 0x80) continue;
    break;
  }
  return i;
}

function consumeBracket(s: string, openIndex: number): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;

  for (let i = openIndex + 1; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return s.length - 1;
}

function consumeParenFunction(
  s: string,
  openParenIndex: number,
): { content: string; endIndex: number } {
  let depth = 1;
  let quote: "'" | '"' | null = null;

  for (let i = openParenIndex + 1; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') i = consumeBracket(s, i);
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { content: s.slice(openParenIndex + 1, i), endIndex: i };
    }
  }
  return { content: s.slice(openParenIndex + 1), endIndex: s.length - 1 };
}

function isCombinatorOrWhitespace(s: string, i: number): boolean {
  const ch = s[i];
  return /\s/.test(ch) || ch === '>' || ch === '+' || ch === '~' || ch === '|';
}

function consumeWhitespaceAndCombinators(s: string, i: number): number {
  let j = i;
  while (j < s.length && /\s/.test(s[j])) j++;
  if (s[j] === '|' && s[j + 1] === '|') return j + 1;
  if (s[j] === '>' || s[j] === '+' || s[j] === '~' || s[j] === '|') return j;
  return j - 1;
}

function extractNthOfSelectorList(content: string): string | null {
  let depthParen = 0;
  let depthBrack = 0;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '\\') {
      i += 1;
      continue;
    }

    if (ch === '[') depthBrack += 1;
    else if (ch === ']' && depthBrack > 0) depthBrack -= 1;
    else if (ch === '(') depthParen += 1;
    else if (ch === ')' && depthParen > 0) depthParen -= 1;

    if (depthParen === 0 && depthBrack === 0) {
      if (isOfTokenAt(content, i)) return content.slice(i + 2).trimStart();
    }
  }

  return null;
}

function isOfTokenAt(s: string, i: number): boolean {
  if (s[i] !== 'o' || s[i + 1] !== 'f') return false;
  const prev = s[i - 1];
  const next = s[i + 2];
  const prevOk = prev === undefined || /\s/.test(prev);
  const nextOk = next === undefined || /\s/.test(next);
  return prevOk && nextOk;
}

export function computeSelectorSpecificity(selector: string): Specificity {
  let ids = 0;
  let classes = 0;
  let types = 0;

  let expectType = true;

  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];

    if (ch === '\\') {
      i += 1;
      continue;
    }

    if (ch === '[') {
      classes += 1;
      i = consumeBracket(selector, i);
      expectType = false;
      continue;
    }

    if (isCombinatorOrWhitespace(selector, i)) {
      i = consumeWhitespaceAndCombinators(selector, i);
      expectType = true;
      continue;
    }

    if (ch === '#') {
      ids += 1;
      i = consumeIdent(selector, i + 1) - 1;
      expectType = false;
      continue;
    }

    if (ch === '.') {
      classes += 1;
      i = consumeIdent(selector, i + 1) - 1;
      expectType = false;
      continue;
    }

    if (ch === ':') {
      const isPseudoEl = selector[i + 1] === ':';
      if (isPseudoEl) {
        types += 1;
        const nameStart = i + 2;
        const nameEnd = consumeIdent(selector, nameStart);
        const name = selector.slice(nameStart, nameEnd).toLowerCase();
        i = nameEnd - 1;

        if (selector[i + 1] === '(' && name === 'slotted') {
          const { content, endIndex } = consumeParenFunction(selector, i + 1);
          const maxArg = maxSpecificity(splitSelectorList(content).map(computeSelectorSpecificity));
          ids += maxArg[1];
          classes += maxArg[2];
          types += maxArg[3];
          i = endIndex;
        }

        expectType = false;
        continue;
      }

      const nameStart = i + 1;
      const nameEnd = consumeIdent(selector, nameStart);
      const name = selector.slice(nameStart, nameEnd).toLowerCase();

      if (LEGACY_PSEUDO_ELEMENTS.has(name)) {
        types += 1;
        i = nameEnd - 1;
        expectType = false;
        continue;
      }

      if (selector[nameEnd] === '(') {
        const { content, endIndex } = consumeParenFunction(selector, nameEnd);
        i = endIndex;

        if (name === 'where') {
          expectType = false;
          continue;
        }

        if (name === 'is' || name === 'not' || name === 'has') {
          const maxArg = maxSpecificity(splitSelectorList(content).map(computeSelectorSpecificity));
          ids += maxArg[1];
          classes += maxArg[2];
          types += maxArg[3];
          expectType = false;
          continue;
        }

        if (name === 'nth-child' || name === 'nth-last-child') {
          classes += 1;
          const ofSelectors = extractNthOfSelectorList(content);
          if (ofSelectors) {
            const maxArg = maxSpecificity(
              splitSelectorList(ofSelectors).map(computeSelectorSpecificity),
            );
            ids += maxArg[1];
            classes += maxArg[2];
            types += maxArg[3];
          }
          expectType = false;
          continue;
        }

        // Other functional pseudo-classes count as class specificity (+1).
        classes += 1;
        expectType = false;
        continue;
      }

      classes += 1;
      i = nameEnd - 1;
      expectType = false;
      continue;
    }

    if (expectType) {
      if (ch === '*') {
        expectType = false;
        continue;
      }
      if (isIdentStart(ch)) {
        types += 1;
        i = consumeIdent(selector, i + 1) - 1;
        expectType = false;
        continue;
      }
    }
  }

  return [0, ids, classes, types] as const;
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
  const selectors = splitSelectorList(selectorText);
  let bestSel: string | null = null;
  let bestSpec: Specificity = ZERO_SPEC;

  for (const sel of selectors) {
    try {
      if (!element.matches(sel)) continue;
      const spec = computeSelectorSpecificity(sel);
      if (!bestSel || compareSpecificity(spec, bestSpec) > 0) {
        bestSel = sel;
        bestSpec = spec;
      }
    } catch {
      // Invalid selector for matches() (e.g. pseudo-elements) => ignore.
    }
  }

  return bestSel ? { matchedSelector: bestSel, specificity: bestSpec } : null;
}
