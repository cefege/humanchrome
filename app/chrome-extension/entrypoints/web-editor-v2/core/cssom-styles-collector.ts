/**
 * CSSOM Styles Collector (Phase 4.6)
 *
 * Provides CSS rule collection and cascade computation using CSSOM.
 * Used for the CSS panel's style source tracking feature.
 *
 * Design goals:
 * - Collect matched CSS rules for an element via CSSOM
 * - Compute cascade (specificity + source order + !important)
 * - Track inherited styles from ancestor elements
 * - Handle Shadow DOM stylesheets
 * - Produce UI-ready snapshot for rendering
 *
 * Limitations (CSSOM-only approach):
 * - No reliable file:line info (only href/label available)
 * - @container/@scope rules are not evaluated
 * - @layer ordering is approximated via source order
 */

// IMP-0046 slice 1: inheritance lookup extracted to ./cssom/inheritance —
// re-exported so existing import paths (`from '.../cssom-styles-collector'`)
// keep working.
export { INHERITED_PROPERTIES, isInheritableProperty } from './cssom/inheritance';
import { isInheritableProperty } from './cssom/inheritance';
// IMP-0046 slice 2: shorthand expansion extracted to ./cssom/shorthand.
export { SHORTHAND_TO_LONGHANDS, expandToLonghands } from './cssom/shorthand';
import { expandToLonghands } from './cssom/shorthand';
// IMP-0046 slice 3: stylesheet inspection helpers extracted to ./cssom/sheet-inspector.
import {
  isSheetApplicable,
  describeStyleSheet,
  safeReadCssRules,
  evalMediaRule,
  evalSupportsRule,
} from './cssom/sheet-inspector';
// IMP-0046 slice 4: Selectors Level 4 specificity parser extracted to
// ./cssom/specificity-parser. compareSpecificity is re-exported for
// downstream callers; the rest are internal to the orchestrator.
export { compareSpecificity } from './cssom/specificity-parser';
import {
  compareSpecificity,
  computeMatchedRuleSpecificity,
  computeSelectorSpecificity,
} from './cssom/specificity-parser';

// =============================================================================
// Public Types (UI-ready snapshot)
// =============================================================================

export type Specificity = readonly [inline: number, ids: number, classes: number, types: number];

const ZERO_SPEC: Specificity = [0, 0, 0, 0] as const;

export type DeclStatus = 'active' | 'overridden';

export interface CssRuleSource {
  url?: string;
  label: string;
}

export interface CssDeclView {
  id: string;
  name: string;
  value: string;
  important: boolean;
  affects: readonly string[];
  status: DeclStatus;
}

export interface CssRuleView {
  id: string;
  origin: 'inline' | 'rule';
  selector: string;
  matchedSelector?: string;
  specificity?: Specificity;
  source?: CssRuleSource;
  order: number;
  decls: CssDeclView[];
}

export interface CssSectionView {
  kind: 'inline' | 'matched' | 'inherited';
  title: string;
  inheritedFrom?: { label: string };
  rules: CssRuleView[];
}

export interface CssPanelSnapshot {
  target: {
    label: string;
    root: 'document' | 'shadow';
  };
  warnings: string[];
  stats: {
    roots: number;
    styleSheets: number;
    rulesScanned: number;
    matchedRules: number;
  };
  sections: CssSectionView[];
}

// =============================================================================
// Internal Types (cascade + collection)
// =============================================================================

interface DeclCandidate {
  id: string;
  important: boolean;
  specificity: Specificity;
  sourceOrder: readonly [sheetIndex: number, ruleOrder: number, declIndex: number];
  property: string;
  value: string;
  affects: readonly string[];
  ownerRuleId: string;
  ownerElementId: number;
}

interface FlatStyleRule {
  sheetIndex: number;
  order: number;
  selectorText: string;
  style: CSSStyleDeclaration;
  source: CssRuleSource;
}

interface RuleIndex {
  root: Document | ShadowRoot;
  rootId: number;
  flatRules: FlatStyleRule[];
  warnings: string[];
  stats: { styleSheets: number; rulesScanned: number };
}

interface CollectElementOptions {
  includeInline: boolean;
  declFilter: (decl: { property: string; affects: readonly string[] }) => boolean;
}

interface CollectedElementRules {
  element: Element;
  elementId: number;
  root: Document | ShadowRoot;
  rootType: 'document' | 'shadow';
  inlineRule: CssRuleView | null;
  matchedRules: CssRuleView[];
  candidates: DeclCandidate[];
  warnings: string[];
  stats: { matchedRules: number };
}

function normalizePropertyName(property: string): string {
  const raw = String(property || '').trim();
  if (!raw) return '';
  if (raw.startsWith('--')) return raw;
  return raw.toLowerCase();
}

// =============================================================================
// Cascade / override
// =============================================================================

function compareSourceOrder(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  if (a[0] !== b[0]) return a[0] > b[0] ? 1 : -1;
  if (a[1] !== b[1]) return a[1] > b[1] ? 1 : -1;
  if (a[2] !== b[2]) return a[2] > b[2] ? 1 : -1;
  return 0;
}

function compareCascade(a: DeclCandidate, b: DeclCandidate): number {
  if (a.important !== b.important) return a.important ? 1 : -1;
  const spec = compareSpecificity(a.specificity, b.specificity);
  if (spec !== 0) return spec;
  return compareSourceOrder(a.sourceOrder, b.sourceOrder);
}

function computeOverrides(candidates: readonly DeclCandidate[]): {
  winners: Map<string, DeclCandidate>;
  declStatus: Map<string, DeclStatus>;
} {
  const winners = new Map<string, DeclCandidate>();

  for (const cand of candidates) {
    for (const longhand of cand.affects) {
      const cur = winners.get(longhand);
      if (!cur || compareCascade(cand, cur) > 0) winners.set(longhand, cand);
    }
  }

  const declStatus = new Map<string, DeclStatus>();
  for (const cand of candidates) declStatus.set(cand.id, 'overridden');
  for (const [, winner] of winners) declStatus.set(winner.id, 'active');

  return { winners, declStatus };
}

// =============================================================================
// CSSOM Rule Index
// =============================================================================

const CONTAINER_RULE = (globalThis as unknown as { CSSRule?: { CONTAINER_RULE?: number } }).CSSRule
  ?.CONTAINER_RULE;
const SCOPE_RULE = (globalThis as unknown as { CSSRule?: { SCOPE_RULE?: number } }).CSSRule
  ?.SCOPE_RULE;

function createRuleIndexForRoot(root: Document | ShadowRoot, rootId: number): RuleIndex {
  const warnings: string[] = [];
  const flatRules: FlatStyleRule[] = [];
  let rulesScanned = 0;

  const docOrShadow = root as DocumentOrShadowRoot;
  const styleSheets: CSSStyleSheet[] = [];

  try {
    for (const s of Array.from(docOrShadow.styleSheets ?? [])) {
      if (s && s instanceof CSSStyleSheet) styleSheets.push(s);
    }
  } catch {
    // ignore
  }

  try {
    const adopted = Array.from(docOrShadow.adoptedStyleSheets ?? []) as CSSStyleSheet[];
    for (const s of adopted) if (s && s instanceof CSSStyleSheet) styleSheets.push(s);
  } catch {
    // ignore
  }

  let order = 0;

  function walkRuleList(
    list: CSSRuleList,
    ctx: {
      sheetIndex: number;
      sourceForRules: CssRuleSource;
      topSheet: CSSStyleSheet;
      stack: Set<CSSStyleSheet>;
    },
  ): void {
    for (const rule of Array.from(list)) {
      rulesScanned += 1;

      if (CONTAINER_RULE && rule.type === CONTAINER_RULE) {
        warnings.push('Skipped @container rules (not evaluated in CSSOM collector)');
        continue;
      }

      if (SCOPE_RULE && rule.type === SCOPE_RULE) {
        warnings.push('Skipped @scope rules (not evaluated in CSSOM collector)');
        continue;
      }

      if (rule.type === CSSRule.IMPORT_RULE) {
        const importRule = rule as CSSImportRule;

        try {
          const mediaText = importRule.media?.mediaText?.trim() ?? '';
          if (
            mediaText &&
            mediaText.toLowerCase() !== 'all' &&
            !window.matchMedia(mediaText).matches
          ) {
            continue;
          }
        } catch {
          // ignore
        }

        const imported = importRule.styleSheet;
        if (imported) {
          // Check for cycle BEFORE adding to stack
          if (ctx.stack.has(imported)) {
            const src = describeStyleSheet(imported, ctx.sheetIndex);
            warnings.push(`Detected @import cycle, skipping: ${src.url ?? src.label}`);
            continue;
          }

          // Add to stack, process, then remove
          ctx.stack.add(imported);
          try {
            // Recursively walk the imported stylesheet
            if (!isSheetApplicable(imported)) {
              continue;
            }

            const cssRules = safeReadCssRules(imported);
            const src = describeStyleSheet(imported, ctx.sheetIndex);

            if (!cssRules) {
              warnings.push(
                `Skipped @import stylesheet (cannot access cssRules, likely cross-origin): ${src.url ?? src.label}`,
              );
              continue;
            }

            walkRuleList(cssRules, {
              sheetIndex: ctx.sheetIndex,
              sourceForRules: src,
              topSheet: imported,
              stack: ctx.stack,
            });
          } finally {
            ctx.stack.delete(imported);
          }
        }
        continue;
      }

      if (rule.type === CSSRule.MEDIA_RULE) {
        if (evalMediaRule(rule as CSSMediaRule, warnings)) {
          walkRuleList((rule as CSSMediaRule).cssRules, ctx);
        }
        continue;
      }

      if (rule.type === CSSRule.SUPPORTS_RULE) {
        if (evalSupportsRule(rule as CSSSupportsRule, warnings)) {
          walkRuleList((rule as CSSSupportsRule).cssRules, ctx);
        }
        continue;
      }

      if (rule.type === CSSRule.STYLE_RULE) {
        const styleRule = rule as CSSStyleRule;
        flatRules.push({
          sheetIndex: ctx.sheetIndex,
          order: order++,
          selectorText: styleRule.selectorText ?? '',
          style: styleRule.style,
          source: ctx.sourceForRules,
        });
        continue;
      }

      // Best-effort: traverse grouping rules we don't explicitly model (e.g. @layer blocks).
      const anyRule = rule as { cssRules?: CSSRuleList };
      if (anyRule.cssRules && typeof anyRule.cssRules.length === 'number') {
        try {
          walkRuleList(anyRule.cssRules, ctx);
        } catch {
          // ignore
        }
      }
    }
  }

  for (let sheetIndex = 0; sheetIndex < styleSheets.length; sheetIndex++) {
    const sheet = styleSheets[sheetIndex]!;
    if (!isSheetApplicable(sheet)) continue;

    const sheetSource = describeStyleSheet(sheet, sheetIndex);
    const cssRules = safeReadCssRules(sheet);
    if (!cssRules) {
      warnings.push(
        `Skipped stylesheet (cannot access cssRules, likely cross-origin): ${sheetSource.url ?? sheetSource.label}`,
      );
      continue;
    }

    // Create a fresh recursion stack for each top-level stylesheet
    const recursionStack = new Set<CSSStyleSheet>();
    recursionStack.add(sheet); // Add self to prevent self-import cycles
    walkRuleList(cssRules, {
      sheetIndex,
      sourceForRules: sheetSource,
      topSheet: sheet,
      stack: recursionStack,
    });
  }

  return {
    root,
    rootId,
    flatRules,
    warnings,
    stats: { styleSheets: styleSheets.length, rulesScanned },
  };
}

// =============================================================================
// Per-element collection
// =============================================================================

function readStyleDecls(style: CSSStyleDeclaration): Array<{
  property: string;
  value: string;
  important: boolean;
  declIndex: number;
}> {
  const out: Array<{ property: string; value: string; important: boolean; declIndex: number }> = [];

  const len = Number(style?.length ?? 0);
  for (let i = 0; i < len; i++) {
    let prop = '';
    try {
      prop = style.item(i);
    } catch {
      prop = '';
    }
    prop = normalizePropertyName(prop);
    if (!prop) continue;

    let value = '';
    let important = false;
    try {
      value = style.getPropertyValue(prop) ?? '';
      important = String(style.getPropertyPriority(prop) ?? '') === 'important';
    } catch {
      value = '';
      important = false;
    }

    out.push({ property: prop, value: String(value).trim(), important, declIndex: i });
  }

  return out;
}

function canReadInlineStyle(element: Element): element is Element & { style: CSSStyleDeclaration } {
  const anyEl = element as { style?: CSSStyleDeclaration };
  return (
    !!anyEl.style &&
    typeof anyEl.style.getPropertyValue === 'function' &&
    typeof anyEl.style.getPropertyPriority === 'function'
  );
}

function formatElementLabel(element: Element, maxClasses = 2): string {
  const tag = element.tagName.toLowerCase();
  const id = (element as HTMLElement).id?.trim();
  if (id) return `${tag}#${id}`;

  const classes = Array.from(element.classList ?? [])
    .slice(0, maxClasses)
    .filter(Boolean);
  if (classes.length) return `${tag}.${classes.join('.')}`;

  return tag;
}

function getElementRoot(element: Element): Document | ShadowRoot {
  try {
    const root = element.getRootNode?.();
    return root instanceof ShadowRoot ? root : (element.ownerDocument ?? document);
  } catch {
    return element.ownerDocument ?? document;
  }
}

function getParentElementOrHost(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;

  try {
    const root = element.getRootNode?.();
    if (root instanceof ShadowRoot) return root.host;
  } catch {
    // ignore
  }

  return null;
}

function collectForElement(
  element: Element,
  index: RuleIndex,
  elementId: number,
  options: CollectElementOptions,
): CollectedElementRules {
  const warnings: string[] = [];
  const matchedRules: CssRuleView[] = [];
  const candidates: DeclCandidate[] = [];

  const rootType: 'document' | 'shadow' = index.root instanceof ShadowRoot ? 'shadow' : 'document';

  let inlineRule: CssRuleView | null = null;

  if (options.includeInline && canReadInlineStyle(element)) {
    const declsRaw = readStyleDecls(element.style);
    const decls: CssDeclView[] = [];

    for (const d of declsRaw) {
      const affects = expandToLonghands(d.property);
      if (!options.declFilter({ property: d.property, affects })) continue;

      const declId = `inline:${elementId}:${d.declIndex}`;

      decls.push({
        id: declId,
        name: d.property,
        value: d.value,
        important: d.important,
        affects,
        status: 'overridden',
      });

      candidates.push({
        id: declId,
        important: d.important,
        specificity: [1, 0, 0, 0] as const,
        sourceOrder: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, d.declIndex],
        property: d.property,
        value: d.value,
        affects,
        ownerRuleId: `inline:${elementId}`,
        ownerElementId: elementId,
      });
    }

    inlineRule = {
      id: `inline:${elementId}`,
      origin: 'inline',
      selector: 'element.style',
      matchedSelector: 'element.style',
      specificity: [1, 0, 0, 0] as const,
      source: { label: 'element.style' },
      order: Number.MAX_SAFE_INTEGER,
      decls,
    };
  }

  for (const flat of index.flatRules) {
    const match = computeMatchedRuleSpecificity(element, flat.selectorText);
    if (!match) continue;

    const declsRaw = readStyleDecls(flat.style);
    const decls: CssDeclView[] = [];
    const ruleId = `rule:${index.rootId}:${flat.sheetIndex}:${flat.order}`;

    for (const d of declsRaw) {
      const affects = expandToLonghands(d.property);
      if (!options.declFilter({ property: d.property, affects })) continue;

      const declId = `${ruleId}:${d.declIndex}`;

      decls.push({
        id: declId,
        name: d.property,
        value: d.value,
        important: d.important,
        affects,
        status: 'overridden',
      });

      candidates.push({
        id: declId,
        important: d.important,
        specificity: match.specificity,
        sourceOrder: [flat.sheetIndex, flat.order, d.declIndex],
        property: d.property,
        value: d.value,
        affects,
        ownerRuleId: ruleId,
        ownerElementId: elementId,
      });
    }

    if (decls.length === 0) continue;

    matchedRules.push({
      id: ruleId,
      origin: 'rule',
      selector: flat.selectorText,
      matchedSelector: match.matchedSelector,
      specificity: match.specificity,
      source: flat.source,
      order: flat.order,
      decls,
    });
  }

  // Sort matched rules in a DevTools-like way (best-effort).
  matchedRules.sort((a, b) => {
    const sa = a.specificity ?? ZERO_SPEC;
    const sb = b.specificity ?? ZERO_SPEC;
    const spec = compareSpecificity(sb, sa); // desc
    if (spec !== 0) return spec;
    return b.order - a.order; // later first
  });

  return {
    element,
    elementId,
    root: index.root,
    rootType,
    inlineRule,
    matchedRules,
    candidates,
    warnings,
    stats: { matchedRules: matchedRules.length },
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Collect matched rules for ONE element (no inheritance), plus DeclCandidate[] used for cascade.
 */
export function collectMatchedRules(element: Element): {
  inlineRule: CssRuleView | null;
  matchedRules: CssRuleView[];
  candidates: DeclCandidate[];
  warnings: string[];
  stats: { styleSheets: number; rulesScanned: number; matchedRules: number };
} {
  const root = getElementRoot(element);

  const index = createRuleIndexForRoot(root, 1);
  const res = collectForElement(element, index, 1, {
    includeInline: true,
    declFilter: () => true,
  });

  return {
    inlineRule: res.inlineRule,
    matchedRules: res.matchedRules,
    candidates: res.candidates,
    warnings: [...index.warnings, ...res.warnings],
    stats: {
      styleSheets: index.stats.styleSheets,
      rulesScanned: index.stats.rulesScanned,
      matchedRules: res.stats.matchedRules,
    },
  };
}

/**
 * Collect full snapshot: inline + matched + inherited chain (ancestor traversal).
 */
export function collectCssPanelSnapshot(
  element: Element,
  options: { maxInheritanceDepth?: number } = {},
): CssPanelSnapshot {
  const warnings: string[] = [];
  const maxDepth = Number.isFinite(options.maxInheritanceDepth)
    ? Math.max(0, options.maxInheritanceDepth!)
    : 10;

  const elementIds = new WeakMap<Element, number>();
  let nextElementId = 1;
  const rootIds = new WeakMap<Document | ShadowRoot, number>();
  let nextRootId = 1;
  // Use WeakMap for caching, but also maintain a list for stats aggregation
  const indexCache = new WeakMap<Document | ShadowRoot, RuleIndex>();
  const indexList: RuleIndex[] = [];

  function getElementId(el: Element): number {
    const existing = elementIds.get(el);
    if (existing) return existing;
    const id = nextElementId++;
    elementIds.set(el, id);
    return id;
  }

  function getIndex(root: Document | ShadowRoot): RuleIndex {
    const cached = indexCache.get(root);
    if (cached) return cached;
    const rootId =
      rootIds.get(root) ??
      (() => {
        const v = nextRootId++;
        rootIds.set(root, v);
        return v;
      })();
    const idx = createRuleIndexForRoot(root, rootId);
    indexCache.set(root, idx);
    indexList.push(idx); // Also add to list for stats aggregation
    return idx;
  }

  if (!element || !element.isConnected) {
    return {
      target: { label: formatElementLabel(element), root: 'document' },
      warnings: ['Target element is not connected; snapshot may be incomplete.'],
      stats: { roots: 0, styleSheets: 0, rulesScanned: 0, matchedRules: 0 },
      sections: [],
    };
  }

  // ---- Target (direct rules) ----
  const targetRoot = getElementRoot(element);
  const targetIndex = getIndex(targetRoot);
  warnings.push(...targetIndex.warnings);

  const targetCollected = collectForElement(element, targetIndex, getElementId(element), {
    includeInline: true,
    declFilter: () => true,
  });

  // Compute overrides on target itself.
  const targetOverrides = computeOverrides(targetCollected.candidates);
  const targetDeclStatus = targetOverrides.declStatus;

  if (targetCollected.inlineRule) {
    for (const d of targetCollected.inlineRule.decls) {
      d.status = targetDeclStatus.get(d.id) ?? 'overridden';
    }
  }
  for (const rule of targetCollected.matchedRules) {
    for (const d of rule.decls) d.status = targetDeclStatus.get(d.id) ?? 'overridden';
  }

  // ---- Ancestor chain (inherited props only) ----
  const ancestors: Element[] = [];
  let cur: Element | null = getParentElementOrHost(element);
  while (cur && ancestors.length < maxDepth) {
    ancestors.push(cur);
    cur = getParentElementOrHost(cur);
  }

  const inheritableLonghands = new Set<string>();

  // Only consider inheritable longhands that appear in collected declarations (keeps work bounded).
  for (const cand of targetCollected.candidates) {
    for (const lh of cand.affects) if (isInheritableProperty(lh)) inheritableLonghands.add(lh);
  }

  const ancestorData: Array<{
    ancestor: Element;
    label: string;
    collected: CollectedElementRules;
    overrides: ReturnType<typeof computeOverrides>;
  }> = [];

  for (const a of ancestors) {
    const aRoot = getElementRoot(a);
    const aIndex = getIndex(aRoot);
    warnings.push(...aIndex.warnings);

    const aCollected = collectForElement(a, aIndex, getElementId(a), {
      includeInline: true,
      declFilter: ({ affects }) => affects.some(isInheritableProperty),
    });

    // Filter candidates to inheritable longhands only (affects subset).
    const filteredCandidates: DeclCandidate[] = [];

    for (const cand of aCollected.candidates) {
      const affects = cand.affects.filter(isInheritableProperty);
      if (affects.length === 0) continue;
      const next: DeclCandidate = { ...cand, affects };
      filteredCandidates.push(next);
      for (const lh of affects) inheritableLonghands.add(lh);
    }

    const aOverrides = computeOverrides(filteredCandidates);

    // Keep only inheritable decls in rule views (already filtered by declFilter), but ensure affects trimmed.
    if (aCollected.inlineRule) {
      aCollected.inlineRule.decls = aCollected.inlineRule.decls
        .map((d) => ({ ...d, affects: d.affects.filter(isInheritableProperty) }))
        .filter((d) => d.affects.length > 0);
      if (aCollected.inlineRule.decls.length === 0) aCollected.inlineRule = null;
    }
    aCollected.matchedRules = aCollected.matchedRules
      .map((r) => ({
        ...r,
        decls: r.decls
          .map((d) => ({ ...d, affects: d.affects.filter(isInheritableProperty) }))
          .filter((d) => d.affects.length > 0),
      }))
      .filter((r) => r.decls.length > 0);

    if (!aCollected.inlineRule && aCollected.matchedRules.length === 0) continue;

    ancestorData.push({
      ancestor: a,
      label: formatElementLabel(a),
      collected: { ...aCollected, candidates: filteredCandidates },
      overrides: aOverrides,
    });
  }

  // Determine which inherited declaration IDs actually provide the final inherited value for target.
  const finalInheritedDeclIds = new Set<string>();

  for (const longhand of inheritableLonghands) {
    if (targetOverrides.winners.has(longhand)) continue;

    for (const a of ancestorData) {
      const win = a.overrides.winners.get(longhand);
      if (win) {
        finalInheritedDeclIds.add(win.id);
        break;
      }
    }
  }

  // Apply inherited statuses: active only if it is the chosen inherited source for any longhand.
  for (const a of ancestorData) {
    if (a.collected.inlineRule) {
      for (const d of a.collected.inlineRule.decls) {
        d.status = finalInheritedDeclIds.has(d.id) ? 'active' : 'overridden';
      }
    }
    for (const r of a.collected.matchedRules) {
      for (const d of r.decls) d.status = finalInheritedDeclIds.has(d.id) ? 'active' : 'overridden';
    }
  }

  // ---- Build sections ----
  const sections: CssSectionView[] = [];

  sections.push({
    kind: 'inline',
    title: 'element.style',
    rules: targetCollected.inlineRule ? [targetCollected.inlineRule] : [],
  });

  sections.push({
    kind: 'matched',
    title: 'Matched CSS Rules',
    rules: targetCollected.matchedRules,
  });

  for (const a of ancestorData) {
    const rules: CssRuleView[] = [];
    if (a.collected.inlineRule) rules.push(a.collected.inlineRule);
    rules.push(...a.collected.matchedRules);

    sections.push({
      kind: 'inherited',
      title: `Inherited from ${a.label}`,
      inheritedFrom: { label: a.label },
      rules,
    });
  }

  // ---- Aggregate stats ----
  let totalStyleSheets = 0;
  let totalRulesScanned = 0;
  const rootsSeen = new Set<number>();
  for (const idx of indexList) {
    rootsSeen.add(idx.rootId);
    totalStyleSheets += idx.stats.styleSheets;
    totalRulesScanned += idx.stats.rulesScanned;
  }

  const dedupWarnings = Array.from(new Set([...warnings, ...targetCollected.warnings]));

  return {
    target: {
      label: formatElementLabel(element),
      root: targetRoot instanceof ShadowRoot ? 'shadow' : 'document',
    },
    warnings: dedupWarnings,
    stats: {
      roots: rootsSeen.size,
      styleSheets: totalStyleSheets,
      rulesScanned: totalRulesScanned,
      matchedRules: targetCollected.stats.matchedRules,
    },
    sections,
  };
}
