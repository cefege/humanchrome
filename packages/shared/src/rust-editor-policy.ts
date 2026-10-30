import { getRustKernel } from './rust-bindings';

export interface EditorCssValue {
  property: string;
  value: string;
}

export interface EditorComputedDiff {
  property: string;
  expected: string;
  actual: string;
  match: boolean;
  reason: 'exact' | 'px_epsilon' | 'matrix_epsilon' | 'string';
}

export interface EditorComputedComparison {
  matches: boolean;
  diffs: EditorComputedDiff[];
}

export interface EditorFingerprint {
  tag: string;
  id?: string;
  classes?: string[];
}

export interface EditorFingerprintRankInput {
  expected: EditorFingerprint;
  candidate: EditorFingerprint;
  expectedText?: string;
  actualText?: string;
  expectedPath?: number[];
  candidatePath?: number[];
  anchorCenter?: { x: number; y: number } | null;
  candidateCenter?: { x: number; y: number } | null;
}

export interface EditorRgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface EditorParsedGradientStop {
  color: string;
  position: number | null;
}

export interface EditorGradientStop {
  color: string;
  position: number;
}

export interface EditorParsedBoxShadow {
  inset: boolean;
  offsetX: string;
  offsetY: string;
  blurRadius: string;
  spreadRadius: string;
  color: string;
}

export interface EditorCssFunctionMatch {
  start: number;
  end: number;
  args: string;
}

export type EditorApplyInstructionType = 'update_text' | 'update_style';

export interface EditorApplyFingerprint {
  tag: string;
  id?: string;
  classes: string[];
  text?: string;
}

export interface EditorApplyDebugSource {
  file: string;
  line?: number;
  column?: number;
  componentName?: string;
}

export interface EditorApplyStyleOperation {
  type: 'update_style';
  before: Record<string, string>;
  after: Record<string, string>;
  removed: string[];
}

export interface EditorApplyPayload {
  pageUrl: string;
  targetFile?: string;
  fingerprint: EditorApplyFingerprint;
  techStackHint?: string[];
  instruction: {
    type: EditorApplyInstructionType;
    description: string;
    text?: string;
    style?: Record<string, string>;
  };
  selectorCandidates?: string[];
  debugSource?: EditorApplyDebugSource;
  operation?: EditorApplyStyleOperation;
}

export interface EditorApplyBatchPayload<TElement = unknown> {
  tabId: number;
  elements: TElement[];
  excludedKeys: string[];
  pageUrl?: string;
}



function kernel() { return getRustKernel(); }

function json(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

/** Coerces a value to a primitive string, retaining the web-editor empty-string fallback. */
export function normalizeEditorString(value: unknown): string {
  return kernel().editor_normalize_string(value) as string;
}

/** Normalizes and validates one web-editor apply payload without JSON serialization. */
export function normalizeEditorApplyPayload(raw: unknown): EditorApplyPayload {
  return kernel().editor_normalize_apply_payload(raw) as EditorApplyPayload;
}

/** Normalizes one web-editor apply-batch payload without copying its opaque element array. */
export function normalizeEditorApplyBatchPayload<TElement = unknown>(
  raw: unknown,
): EditorApplyBatchPayload<TElement> {
  return kernel().editor_normalize_apply_batch_payload(raw) as EditorApplyBatchPayload<TElement>;
}

/** Compares host-read computed CSS values using the Rust-owned tolerance policy. */
export function compareEditorComputed(
  expected: readonly EditorCssValue[],
  actual: readonly EditorCssValue[],
  options?: { pxEpsilon?: number; matrixEpsilon?: number },
): EditorComputedComparison {
  return JSON.parse(kernel().editor_compare_computed(json({ ...options, expected, actual }))) as EditorComputedComparison;
}

/** Collapses JavaScript whitespace for editor display and fingerprint matching. */
export function normalizeEditorText(value: string): string {
  return JSON.parse(kernel().editor_normalize_text(json(value))) as string;
}

/** Formats a standalone custom-property reference. */
export function formatEditorCssVar(name: string, fallback?: string): string {
  return JSON.parse(kernel().editor_format_css_var(json(name), json(fallback))) as string;
}

/** Parses a standalone custom-property reference, preserving omitted fallback fields. */
export function parseEditorCssVar(value: string): { name: string; fallback?: string } | null {
  return JSON.parse(kernel().editor_parse_css_var(json(value))) as { name: string; fallback?: string } | null;
}

/** Extracts custom-property names from CSS text. */
export function extractEditorCssVarNames(value: string): string[] {
  return JSON.parse(kernel().editor_extract_css_var_names(json(value))) as string[];
}

/** Scores a collected HMR candidate without sending its opaque DOM handle to WASM. */
export function scoreEditorFingerprintCandidate(input: EditorFingerprintRankInput): number | null {
  return kernel().editor_score_fingerprint_candidate(json(input)) ?? null;
}

/** Parses the gradient editor's supported hex color forms in Rust. */
export function parseEditorHexColor(value: string): EditorRgbaColor | null {
  return JSON.parse(kernel().editor_parse_hex_color(json(value))) as EditorRgbaColor | null;
}

/** Parses the gradient editor's supported RGB/RGBA color forms in Rust. */
export function parseEditorRgbColor(value: string): EditorRgbaColor | null {
  return JSON.parse(kernel().editor_parse_rgb_color(json(value))) as EditorRgbaColor | null;
}

/** Formats an RGBA gradient color for authored CSS. */
export function formatEditorRgba(color: EditorRgbaColor): string {
  return JSON.parse(kernel().editor_rgba_to_css(json(color))) as string;
}

/** Interpolates gradient colors after applying the historical progress clamp. */
export function interpolateEditorRgba(
  left: EditorRgbaColor,
  right: EditorRgbaColor,
  t: number,
): EditorRgbaColor {
  return JSON.parse(kernel().editor_interpolate_rgba(json(left), json(right), t)) as EditorRgbaColor;
}

/** Normalizes gradient-stop positions with Rust-owned CSS ordering policy. */
export function normalizeEditorGradientStops(
  stops: readonly EditorParsedGradientStop[],
): EditorGradientStop[] {
  return JSON.parse(kernel().editor_normalize_gradient_stops(json(stops))) as EditorGradientStop[];
}

/** Maps inline gradient stops to nearest resolved computed colors. */
export function editorGradientPlaceholderMapping(
  inline: readonly EditorGradientStop[],
  computed: readonly EditorGradientStop[],
): string[] {
  return JSON.parse(
    kernel().editor_gradient_placeholder_mapping(json(inline), json(computed)),
  ) as string[];
}

/** Parses the first effects-control box-shadow through the Rust CSS scanner. */
export function parseEditorBoxShadow(value: string): EditorParsedBoxShadow | null {
  return JSON.parse(kernel().editor_parse_box_shadow(json(value))) as EditorParsedBoxShadow | null;
}

/** Normalizes an effects-control length through the Rust policy. */
export function normalizeEditorLength(value: string): string {
  return JSON.parse(kernel().editor_normalize_length(json(value))) as string;
}

/** Locates a named CSS function through the Rust quote-aware scanner. */
export function findEditorCssFunction(value: string, name: string): EditorCssFunctionMatch | null {
  return JSON.parse(kernel().editor_find_css_function(json(value), json(name))) as EditorCssFunctionMatch | null;
}

/** Splits CSS at top-level separators through the Rust quote-aware scanner. */
export function splitEditorCssTopLevel(value: string, separator: string): string[] {
  return JSON.parse(kernel().editor_split_css_top_level(json(value), json(separator))) as string[];
}

/** Tokenizes CSS at top-level whitespace through the Rust quote-aware scanner. */
export function tokenizeEditorCssTopLevel(value: string): string[] {
  return JSON.parse(kernel().editor_tokenize_css_top_level(json(value))) as string[];
}

/** Compares CSS specificity tuples with the Rust cascade ordering policy. */
export function compareEditorSpecificity(left: readonly number[], right: readonly number[]): number {
  return Number(kernel().editor_compare_specificity(json(left), json(right)));
}

/** Splits a selector list without breaking quoted, escaped, functional, or attribute content. */
export function splitEditorSelectorList(value: string): string[] {
  return JSON.parse(kernel().editor_split_selector_list(json(value))) as string[];
}

/** Computes the editor's complete historical Level-4 specificity grammar. */
export function computeEditorSpecificity(value: string): readonly [number, number, number, number] {
  return JSON.parse(getRustKernel().editor_compute_specificity(json(value)));
}

/** Ranks one host-matched collection in Rust, retaining the first match on a specificity tie. */
export function selectEditorMatchedSpecificity(
  selectors: readonly string[],
): { index: number; specificity: readonly [number, number, number, number] } | null {
  return JSON.parse(getRustKernel().editor_matched_specificity(json(selectors)));
}

/** Normalizes a browser-read CSS value with the Rust computed-map policy. */
export function normalizeEditorCssValue(value: string): string {
  return JSON.parse(getRustKernel().editor_normalize_css_value(json(value)));
}

/** Normalizes a CSSOM property name before Rust-owned inheritance/shorthand decisions. */
export function normalizeEditorCssProperty(property: string): string {
  const hostNormalized = String(property || '').trim();
  return JSON.parse(getRustKernel().editor_normalize_css_property(json(hostNormalized))) as string;
}

/** Tests the editor's curated inheritable-property policy. */
export function isEditorInheritableProperty(property: string): boolean {
  return getRustKernel().editor_is_inheritable_property(
    json(normalizeEditorCssProperty(property)),
  );
}

/** Expands one CSSOM declaration into the longhands tracked by the cascade policy. */
export function expandEditorCssShorthand(property: string): readonly string[] {
  return JSON.parse(
    getRustKernel().editor_expand_css_shorthand(json(normalizeEditorCssProperty(property))),
  ) as string[];
}

export interface EditorCascadeRank {
  important: boolean;
  specificity: readonly [number, number, number, number];
  sourceOrder: readonly [number, number, number];
}

/** Compares source-order tuples without losing non-finite JavaScript numbers. */
export function compareEditorSourceOrder(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return getRustKernel().editor_compare_source_order(left, right);
}

/** Compares importance, specificity and source order through the Rust cascade policy. */
export function compareEditorCascade(left: EditorCascadeRank, right: EditorCascadeRank): number {
  return getRustKernel().editor_compare_cascade(left, right);
}

/** Resolves a whole declaration collection without copying CSS values or DOM/rule handles. */
export function computeEditorCascadeOverrides(
  candidates: readonly (EditorCascadeRank & { id: string; affects: readonly string[] })[],
): { winners: [string, number][]; activeIds: string[] } {
  return getRustKernel().editor_cascade_overrides(candidates);
}

export interface EditorSnapRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface EditorSnapViewport {
  width: number;
  height: number;
}

export interface EditorSnapResize {
  hasWest: boolean;
  hasEast: boolean;
  hasNorth: boolean;
  hasSouth: boolean;
}

export interface EditorSnapAnchorX {
  value: number;
  type: 'left' | 'center' | 'right';
  source: 'sibling' | 'viewport';
  sourceRect?: EditorSnapRect;
}

export interface EditorSnapAnchorY {
  value: number;
  type: 'top' | 'middle' | 'bottom';
  source: 'sibling' | 'viewport';
  sourceRect?: EditorSnapRect;
}

export interface EditorSnapAnchors {
  x: readonly EditorSnapAnchorX[];
  y: readonly EditorSnapAnchorY[];
}

export interface EditorSnapLockX {
  type: EditorSnapAnchorX['type'];
  value: number;
  source: EditorSnapAnchorX['source'];
  sourceRect: EditorSnapRect | null;
}

export interface EditorSnapLockY {
  type: EditorSnapAnchorY['type'];
  value: number;
  source: EditorSnapAnchorY['source'];
  sourceRect: EditorSnapRect | null;
}

export interface EditorSnapLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface EditorSnapResult {
  snappedRect: EditorSnapRect;
  guideLines: readonly EditorSnapLine[];
  lockX: EditorSnapLockX | null;
  lockY: EditorSnapLockY | null;
}

export interface EditorSnapDistanceLabel {
  kind: 'sibling' | 'viewport';
  axis: 'x' | 'y';
  value: number;
  text: string;
  line: EditorSnapLine;
}

export interface EditorSnapInput {
  rect: EditorSnapRect;
  resize: EditorSnapResize;
  anchors: EditorSnapAnchors;
  thresholdPx: number;
  hysteresisPx: number;
  minSizePx: number;
  lockX: EditorSnapLockX | null;
  lockY: EditorSnapLockY | null;
  viewport: EditorSnapViewport;
}

export interface EditorSnapDistanceInput {
  rect: EditorSnapRect;
  lockX: EditorSnapLockX | null;
  lockY: EditorSnapLockY | null;
  viewport: EditorSnapViewport;
  minGapPx: number;
}

/** Runs the compatibility snap operation without serializing numeric values through JSON. */
export function computeEditorSnap(input: EditorSnapInput): EditorSnapResult {
  return getRustKernel().editor_compute_snap(input) as EditorSnapResult;
}

/** Runs the compatibility distance-label operation without serializing numeric values through JSON. */
export function computeEditorSnapDistanceLabels(
  input: EditorSnapDistanceInput,
): readonly EditorSnapDistanceLabel[] {
  return getRustKernel().editor_compute_snap_distance_labels(input) as EditorSnapDistanceLabel[];
}

/** Owns one gesture's anchors and hysteresis locks inside the Rust kernel. */
export interface EditorSnapState {
  setTargets(anchors: EditorSnapAnchors): void;
  compute(input: Omit<EditorSnapInput, 'anchors' | 'lockX' | 'lockY'>): EditorSnapResult;
  distanceLabels(
    input: Omit<EditorSnapDistanceInput, 'lockX' | 'lockY'>,
  ): readonly EditorSnapDistanceLabel[];
}

/** Creates a stateful snap handle; callers bulk-load anchors once per resize gesture. */
export function createEditorSnapState(): EditorSnapState {
  const state = new (getRustKernel().RustEditorSnapState)();
  return {
    setTargets(anchors) {
      state.set_targets(anchors);
    },
    compute(input) {
      return state.compute(input) as EditorSnapResult;
    },
    distanceLabels(input) {
      return state.distance_labels(input) as EditorSnapDistanceLabel[];
    },
  };
}
