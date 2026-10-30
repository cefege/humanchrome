import { getRustKernel } from './rust-bindings';

export type SelectorType = 'css' | 'xpath' | 'attr' | 'aria' | 'text' | 'role' | 'label' | 'placeholder' | 'alt' | 'title' | 'testid';
export type SelectorCandidateSource = 'recorded' | 'user' | 'generated';
export type TextMatchMode = 'exact' | 'contains';
export interface SelectorStabilitySignals { usesId?: boolean; usesTestId?: boolean; usesAria?: boolean; usesText?: boolean; usesNthOfType?: boolean; usesAttributes?: boolean; usesClass?: boolean; }
export interface SelectorStability { score: number; signals?: SelectorStabilitySignals; note?: string; }
export interface SelectorCandidate { type: SelectorType; value: string; weight?: number; source?: SelectorCandidateSource; strategy?: string; stability?: SelectorStability; match?: TextMatchMode; tagNameHint?: string; role?: string; name?: string; text?: string; exact?: boolean; attribute?: string; }
export interface SelectorGenerationOptions { maxCandidates?: number; includeText?: boolean; includeAria?: boolean; includeCssUnique?: boolean; includeCssPath?: boolean; testIdAttributes?: readonly string[]; textMaxLength?: number; textTags?: readonly string[]; }
export interface NormalizedSelectorGenerationOptions { maxCandidates: number; includeText: boolean; includeAria: boolean; includeCssUnique: boolean; includeCssPath: boolean; testIdAttributes: readonly string[]; textMaxLength: number; textTags: readonly string[]; }
export interface SelectorTarget<T extends SelectorCandidate = SelectorCandidate> { selector?: string; candidates: [T, ...T[]]; tagName?: string; }
export interface CompositeSelectorParts { frameSelector: string; innerSelector: string; }
export interface ParsedPrefixedSelector { kind: Exclude<SelectorType, 'attr' | 'aria'>; value: string; role?: string; name?: string; exact?: boolean; raw: string; }
export interface ElementFingerprint { tag: string; id?: string; classes?: string[]; text?: string; raw: string; }
export interface FingerprintInput { tagName?: string; id?: string; classes: readonly string[]; textContent?: string; }
export interface FingerprintOptions { textMaxLength?: number; maxClasses?: number; }

type SelectorCandidatePatch = Partial<Pick<SelectorCandidate, 'source' | 'stability' | 'weight'>>;

export interface ActionSelectorCandidateInput {
  type: 'css' | 'attr' | 'xpath' | 'aria' | 'text';
  selector?: unknown;
  xpath?: unknown;
  text?: unknown;
  role?: unknown;
  name?: unknown;
  weight?: number;
  source?: SelectorCandidateSource;
  stability?: SelectorStability;
  match?: TextMatchMode;
  tagNameHint?: string;
}

export interface ActionSelectorTargetInput {
  selector?: string;
  tag?: string;
  ref?: string;
  hint?: { tagName?: string };
  candidates?: readonly ActionSelectorCandidateInput[];
}

export type PreparedActionSelectorCandidate = {
  [Kind in ActionSelectorCandidateInput['type']]: SelectorCandidate & { type: Kind };
}[ActionSelectorCandidateInput['type']];

export interface PreparedActionSelectorTarget {
  selectorTarget: SelectorTarget<PreparedActionSelectorCandidate> & { ref?: string };
  firstCandidateType?: string;
  firstCssOrAttr?: string;
}

/** Resolves and prepares one complete action target while retaining opaque metadata identity. */
export function prepareRustActionSelectorTarget(
  target: ActionSelectorTargetInput,
  variables: Record<string, unknown>,
): PreparedActionSelectorTarget {
  return getRustKernel().selector_action_target(target, variables);
}

export function clampRustActionInteger(value: number, min: number, max: number): number {
  return getRustKernel().selector_clamp_action_integer(value, min, max);
}

interface RankedSelectorCandidates {
  candidateIndexes: number[];
  patches: SelectorCandidatePatch[];
  selector: string;
  tagName: string | null;
}

interface SortedSelectorCandidates {
  candidateIndexes: number[];
  patches: SelectorCandidatePatch[];
}

export interface EditorLocatorPlan {
  defaultMaxCandidates: number;
  dataAttributes: readonly string[];
  anchorAttributes: readonly string[];
  maxClassComboDepth: number;
  maxSelectorClassCount: number;
  maxAnchorDepth: number;
  maxCandidates: number;
  headLimit: number;
  collectAnchor: boolean;
}

/** Ranks a complete collection in Rust while retaining caller candidate identity and metadata. */
export function rankSelectorCandidates<T extends SelectorCandidate>(
  candidates: readonly T[],
  options?: SelectorGenerationOptions,
  tagName?: string,
): SelectorTarget<T> {
  const result = decode<RankedSelectorCandidates>(
    getRustKernel().selector_rank(json(candidates.map(candidateProjection)), json(optionsProjection(options)), json(tagName)),
  );
  const ranked = result.candidateIndexes.map((index, position) =>
    index < 0
      ? ({
          type: 'css',
          value: 'body',
          source: 'generated',
          strategy: 'fallback',
          stability: result.patches[position]?.stability,
        } as T)
      : ({ ...candidates[index]!, ...result.patches[position] } as T),
  );
  return {
    selector: result.selector,
    candidates: ranked as [T, ...T[]],
    ...(result.tagName === null ? {} : { tagName: result.tagName }),
  };
}

export interface SortedSelectorCandidate<T extends SelectorCandidate> {
  candidate: T;
  sourceIndex: number;
}

/** Reorders a complete persisted collection without deduplicating or truncating it. */
export function sortSelectorCandidateEntries<T extends SelectorCandidate>(
  candidates: readonly T[],
): SortedSelectorCandidate<T>[] {
  const result = decode<SortedSelectorCandidates>(getRustKernel().selector_sort(json(candidates.map(candidateProjection))));
  return result.candidateIndexes.map((index, position) => ({
    candidate: { ...candidates[index]!, ...result.patches[position] } as T,
    sourceIndex: index,
  }));
}

/** Reorders a complete persisted collection without deduplicating or truncating it. */
export function sortSelectorCandidates<T extends SelectorCandidate>(
  candidates: readonly T[],
): T[] {
  return sortSelectorCandidateEntries(candidates).map(({ candidate }) => candidate);
}
/** Legacy single-comparison compatibility; use batch ranking for hot paths. */
export function compareRustSelectorCandidates(left: SelectorCandidate, right: SelectorCandidate): number { return getRustKernel().selector_compare(json(candidateProjection(left)), json(candidateProjection(right))); }
export function rustSelectorStability(candidate: SelectorCandidate): SelectorStability { return decode(getRustKernel().selector_stability(json(candidateProjection(candidate)))); }
export function rustSelectorCandidateKey(candidate: SelectorCandidate): string { return decode(getRustKernel().selector_candidate_key(json(candidateProjection(candidate)))); }
// Reuse one Rust-produced configuration buffer, never a caller-mutable decoded object.
let normalizedOptionsBuffer: { input: string; output: string } | undefined;

export function normalizeRustSelectorOptions(options?: SelectorGenerationOptions): NormalizedSelectorGenerationOptions {
  const kernel = getRustKernel();
  const input = json(optionsProjection(options));
  if (normalizedOptionsBuffer?.input !== input) {
    normalizedOptionsBuffer = { input, output: kernel.selector_normalize_options(input) };
  }
  return decode(normalizedOptionsBuffer.output);
}
/** Uses the full historical identifier fallback only when native CSS.escape is unavailable. */
export function rustCssEscapeFallback(value: string): string {
  return decode(getRustKernel().selector_css_escape_fallback(json(value), json('identifier')));
}
/** Uses the historical test-id attribute fallback only when native CSS.escape is unavailable. */
export function rustTestIdAttributeEscapeFallback(value: string): string {
  return decode(getRustKernel().selector_css_escape_fallback(json(value), json('testid-attribute')));
}
/** Returns web-editor DOM collection limits and fallback reservation policy. */
export function rustEditorLocatorPlan(maxCandidates?: number, anchorAvailable = false): EditorLocatorPlan {
  return decode(getRustKernel().selector_editor_locator_plan(json(maxCandidates), anchorAvailable));
}
/** Filters a raw DOM class list under the web-editor locator policy. */
export function rustEditorLocatorClassIndexes(classes: readonly string[]): number[] {
  return decode(getRustKernel().selector_editor_locator_class_indexes(json(classes)));
}
/** Selects a complete web-editor candidate batch while preserving DOM-generated selector strings. */
export function selectRustEditorLocatorCandidates(
  headCandidates: readonly string[],
  pathCandidate: string | null,
  anchorCandidate: string | null,
  maxCandidates?: number,
): string[] {
  return decode(
    getRustKernel().selector_editor_locator_select(
      json(headCandidates),
      json(pathCandidate),
      json(anchorCandidate),
      json(maxCandidates),
    ),
  );
}
export function splitRustCompositeSelector(selector: string): CompositeSelectorParts | null { return decode(getRustKernel().selector_split_composite(json(selector))); }
export function isRustCompositeSelector(selector: string): boolean { return getRustKernel().selector_is_composite(json(selector)); }
export function composeRustCompositeSelector(frameSelector: string, innerSelector: string): string { return decode(getRustKernel().selector_compose_composite(json(frameSelector), json(innerSelector))); }
export function parseRustPrefixedSelector(selector: string): ParsedPrefixedSelector { return decode(getRustKernel().selector_parse_prefixed(json(selector))); }
export function rustPrefixedSelectorCandidate(selector: string): SelectorCandidate | null { return decode(getRustKernel().selector_prefixed_candidate(json(selector))); }
export function parseRustRoleSelector(selector: string): Pick<ParsedPrefixedSelector, 'role' | 'name' | 'exact'> { return decode(getRustKernel().selector_parse_role(json(selector))); }
export function parseRustAriaExpression(expression: string): Pick<ParsedPrefixedSelector, 'role' | 'name'> { return decode(getRustKernel().selector_parse_aria_expression(json(expression))); }
export function rustAriaToCss(role?: string, name?: string): string[] { return decode(getRustKernel().selector_aria_to_css(json(role), json(name))); }
export function computeRustFingerprint(input: FingerprintInput, options?: FingerprintOptions): string { return decode(getRustKernel().selector_compute_fingerprint(json(input), json(options))); }
export function parseRustFingerprint(fingerprint: string): ElementFingerprint { return decode(getRustKernel().selector_parse_fingerprint(json(fingerprint))); }
export function verifyRustFingerprint(tagName: string | undefined, id: string | undefined, fingerprint: string): boolean { return getRustKernel().selector_verify_fingerprint(json(tagName), json(id), json(fingerprint)); }
export function rustFingerprintSimilarity(left: string, right: string): number { return getRustKernel().selector_fingerprint_similarity(json(left), json(right)); }
export function rustFingerprintMatches(left: string, right: string, threshold?: number): { match: boolean; score: number } { return decode(getRustKernel().selector_fingerprint_matches(json(left), json(right), json(threshold))); }
export function rustDeriveFrameSelector(target: SelectorTarget): string | null { return decode(getRustKernel().selector_derive_frame(json(targetProjection(target)))); }
export function rustDeriveTagNameHint(target: SelectorTarget, candidateIndex?: number): string | null { return decode(getRustKernel().selector_derive_tag_hint(json(targetProjection(target)), candidateIndex ?? -1)); }
const NON_FINITE_NUMBER_KEY = '__humanchromeNumber';

// Project only policy DTO fields. Opaque host resources remain on the original objects.
function optionsProjection(options?: SelectorGenerationOptions): SelectorGenerationOptions {
  return {
    maxCandidates: options?.maxCandidates,
    includeText: options?.includeText,
    includeAria: options?.includeAria,
    includeCssUnique: options?.includeCssUnique,
    includeCssPath: options?.includeCssPath,
    testIdAttributes: options?.testIdAttributes,
    textMaxLength: options?.textMaxLength,
    textTags: options?.textTags,
  };
}

function candidateProjection(candidate: SelectorCandidate): SelectorCandidate {
  const stability = candidate.stability;
  const signals = stability?.signals;
  return {
    type: candidate.type,
    value: candidate.value,
    weight: candidate.weight,
    source: candidate.source,
    strategy: candidate.strategy,
    match: candidate.match,
    tagNameHint: candidate.tagNameHint,
    role: candidate.role,
    name: candidate.name,
    text: candidate.text,
    exact: candidate.exact,
    attribute: candidate.attribute,
    stability: stability && {
      score: stability.score,
      note: stability.note,
      signals: signals && {
        usesId: signals.usesId,
        usesTestId: signals.usesTestId,
        usesAria: signals.usesAria,
        usesText: signals.usesText,
        usesNthOfType: signals.usesNthOfType,
        usesAttributes: signals.usesAttributes,
        usesClass: signals.usesClass,
      },
    },
  };
}

function targetProjection(target: SelectorTarget): SelectorTarget {
  return {
    selector: target.selector,
    candidates: target.candidates.map(candidateProjection) as [SelectorCandidate, ...SelectorCandidate[]],
    tagName: target.tagName,
  };
}

function json(value: unknown): string {
  return (
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== 'number' || Number.isFinite(nested)) return nested;
      return {
        [NON_FINITE_NUMBER_KEY]: Number.isNaN(nested)
          ? 'NaN'
          : nested === Infinity
            ? 'Infinity'
            : '-Infinity',
      };
    }) ?? 'null'
  );
}

function decode<T>(value: string): T {
  // Rust emits non-finite marker keys literally; ordinary DTOs need no per-property reviver.
  if (!value.includes(NON_FINITE_NUMBER_KEY)) return JSON.parse(value) as T;
  return JSON.parse(value, (_key, nested: unknown) => {
    if (
      typeof nested !== 'object' ||
      nested === null ||
      Array.isArray(nested) ||
      Object.keys(nested).length !== 1 ||
      !(NON_FINITE_NUMBER_KEY in nested)
    ) {
      return nested;
    }
    switch ((nested as Record<string, unknown>)[NON_FINITE_NUMBER_KEY]) {
      case 'NaN':
        return NaN;
      case 'Infinity':
        return Infinity;
      case '-Infinity':
        return -Infinity;
      default:
        return nested;
    }
  }) as T;
}

/** Converts a host-coerced, trimmed legacy ARIA candidate to its ordered CSS fallbacks. */
export function legacyAriaSelectors(value: string): string[] {
  return JSON.parse(getRustKernel().selector_legacy_aria_selectors(JSON.stringify(value)));
}

export function normalizeRustAccessibleName(value: string): string {
  return getRustKernel().selector_normalize_accessible_name(value);
}

export function matchesRustAccessibleName(
  computed: string,
  target: string,
  mode: 'exact' | 'iexact' | 'contains' = 'contains',
): boolean {
  return getRustKernel().selector_matches_accessible_name(computed, target, mode);
}
