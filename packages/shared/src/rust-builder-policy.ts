import { getRustKernel } from './rust-bindings';

export interface BuilderSearchRank {
  score: number;
  priority: number;
  index: number;
}

export interface BuilderModelSelection {
  preset: string;
  version: 'full' | 'quantized' | 'compressed';
  dimension?: number;
}

export interface ScreenshotScaleInput {
  x: number;
  y: number;
  screenshotWidth: number;
  screenshotHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

function encode(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

function decode<T>(value: string): T {
  return JSON.parse(value) as T;
}

/** Orders provider results by portable score and priority policy; equal title ties remain a browser intrinsic. */
export function builderQuickPanelRankOrder(ranks: readonly BuilderSearchRank[]): number[] {
  return decode<number[]>(getRustKernel().builder_quick_panel_rank_order(encode(ranks)));
}

/** Scales screenshot-space coordinates using the Rust policy while the tab-context map remains browser-owned. */
export function builderScaleScreenshotCoordinates(input: ScreenshotScaleInput): { x: number; y: number } {
  return getRustKernel().builder_scale_screenshot_coordinates(
    input.x,
    input.y,
    input.screenshotWidth,
    input.screenshotHeight,
    input.viewportWidth,
    input.viewportHeight,
  );
}

/** Compares portable model identity without accessing Chrome storage or an offscreen document. */
export function builderNeedsModelSwitch(
  current: BuilderModelSelection | null,
  requested: BuilderModelSelection,
): boolean {
  return getRustKernel().builder_needs_model_switch(
    current?.preset,
    current?.version,
    current?.dimension,
    requested.preset,
    requested.version,
    requested.dimension,
  );
}

/** Selects the existing model recommendation for a declared use scenario. */
export function builderRecommendModelForLanguage(scenario: 'speed' | 'balanced' | 'quality'): string {
  return getRustKernel().builder_recommend_model_for_language(scenario);
}

/** Selects the existing model recommendation from caller-supplied device observations. */
export function builderRecommendModelForDevice(
  deviceMemory: number,
  networkSpeed: 'slow' | 'fast',
  prioritizeSpeed: boolean,
): string {
  return getRustKernel().builder_recommend_model_for_device(deviceMemory, networkSpeed, prioritizeSpeed);
}

/** Returns a portable builder default while the host continues to supply random branch identifiers. */
export function builderDefaultConfig(nodeType: string, branchId = ''): Record<string, unknown> {
  return decode<Record<string, unknown>>(getRustKernel().builder_default_config(nodeType, branchId));
}

/** Validates JSON-shaped builder configuration using Rust-owned rule selection and message ordering. */
export function builderValidateNode(nodeType: string, config: unknown): string[] {
  return decode<string[]>(getRustKernel().builder_validate_node(nodeType, encode(config)));
}

/** Detects a V3 import shape with Rust-owned field policy. */
export function builderIsFlowV3(value: unknown): boolean {
  return getRustKernel().builder_is_flow_v3(encode(value));
}

/** Detects a legacy V2 import shape while retaining the omitted-schema distinction. */
export function builderIsFlowV2(value: unknown): boolean {
  return getRustKernel().builder_is_flow_v2(encode(value));
}

/** Extracts imported flow candidates in the existing container order. */
export function builderExtractFlowCandidates(value: unknown): unknown[] {
  return decode<unknown[]>(getRustKernel().builder_extract_flow_candidates(encode(value)));
}

/** Applies screenshot metadata expiry using explicit host time. */
export function builderScreenshotContextExpired(timestamp: number, now: number): boolean {
  return getRustKernel().builder_screenshot_context_expired(timestamp, now);
}
