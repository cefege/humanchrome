import { getRustKernel } from './rust-bindings';

export interface MarkerUrlParts {
  url: string;
  origin: string;
  host: string;
  path: string;
}

export interface MarkerMatchInput {
  matchType?: unknown;
  origin?: unknown;
  host?: unknown;
  path?: unknown;
}

export interface RegistryEntryMetadata {
  clientId: string;
  tabId: number;
  valueIsDefined: boolean;
}

export type PaceProfile = 'off' | 'human' | 'careful' | 'fast';
export type PaceInputPlan =
  | { kind: 'read' }
  | { kind: 'invalidProfileType' }
  | { kind: 'invalidProfileValue'; profile: string }
  | { kind: 'set'; profile: PaceProfile; minGapMs: number | null; jitterMs: number | null };

/** Structured category and message selected from a browser tab-operation error. */
export interface TabErrorMessagePlan {
  code: 'TAB_CLOSED' | 'UNKNOWN';
  message: string;
}

/** Browser-native URL facts used only as observations by Rust navigation policy. */
interface NavigationUrlFacts {
  protocol: string;
  host: string;
  hostname: string;
  pathname: string;
  search: string;
}

export interface CloseTabFilterInput {
  urlMatches?: unknown;
  titleMatches?: unknown;
  olderThanMs?: unknown;
}

export interface CloseTabCandidateMetadata {
  id?: number;
  url: string;
  title: string;
  createdAt?: number;
}

export type CloseTabSelection = { kind: 'invalid' } | { kind: 'selected'; indexes: number[] };

/**
 * Classifies only a plain tab-operation message; opaque errors and ToolError identity stay host-owned.
 *
 * `String(tabId)` deliberately uses the JavaScript intrinsic before crossing the JSON boundary.
 */
export function classifyTabErrorMessage(message: string, tabId: number | undefined): TabErrorMessagePlan {
  const tabIdDisplay = typeof tabId === 'number' ? String(tabId) : null;
  return decode(
    getRustKernel().browser_metadata_classify_tab_error(json(message), json(tabIdDisplay)),
  );
}

/** Uses the browser's URL intrinsic while Rust owns the resulting marker-field normalization. */
export function normalizeMarkerUrl(raw: string): MarkerUrlParts {
  let parsed: Omit<MarkerUrlParts, 'url'> | null = null;
  try {
    const url = new URL(raw);
    parsed = { origin: url.origin, host: url.hostname, path: url.pathname };
  } catch {
    // Invalid URLs deliberately retain their raw URL while all lookup fields are empty.
  }
  return decode(getRustKernel().browser_metadata_normalize_marker_url(json(raw), json(parsed)));
}

/**
 * Expands one navigation target into Chrome query patterns.
 *
 * The browser supplies only native `URL` observations; wildcard, suffix-fallback, and domain
 * expansion policy remain in Rust.
 */
export function buildNavigationUrlPatterns(input: string): string[] {
  return decode(
    getRustKernel().browser_metadata_navigation_url_patterns(json(input), json(navigationUrlFacts(input))),
  );
}

/** Selects an existing tab position while Chrome tab objects remain in the browser host. */
export function pickBestNavigationCandidateIndex(
  target: string,
  tabs: readonly { url?: string }[],
): number | undefined {
  const index = decode<number | null>(
    getRustKernel().browser_metadata_pick_navigation_candidate(
      json(navigationUrlFacts(target)),
      json(tabs.map((tab) => navigationUrlFacts(tab.url ?? ''))),
    ),
  );
  return index ?? undefined;
}

/**
 * Selects close-tab candidate positions with Rust-owned filter policy.
 *
 * JavaScript supplies tracked creation timestamps and performs only native String/RegExp
 * observations inside the WASM export, preserving browser regex semantics and object ownership.
 */
export function selectCloseTabIndexes(
  filters: CloseTabFilterInput,
  candidates: readonly CloseTabCandidateMetadata[],
  exceptTabIds: unknown,
  nowMs: number,
): CloseTabSelection {
  return decode(
    getRustKernel().browser_metadata_close_tab_match_indexes(
      json(filters),
      json(candidates),
      json(exceptTabIds),
      nowMs,
    ),
  );
}

/** Returns matching marker indexes so IndexedDB rows and object identity stay host-owned. */
export function matchingMarkerIndexes(
  markers: readonly (MarkerMatchInput | null | undefined)[],
  current: MarkerUrlParts,
): number[] {
  return decode(getRustKernel().browser_metadata_matching_marker_indexes(json(markers), json(current)));
}

/** Resolves an absent or empty request client into the resource registry's system lane. */
export function resolveRegistryClientId(clientId: string | undefined): string {
  return decode(getRustKernel().browser_metadata_registry_client_key(json(clientId)));
}

/** Returns defined-value entry positions that a closed tab must evict. */
export function registryForgetTabIndexes(entries: readonly RegistryEntryMetadata[], tabId: number): number[] {
  return decode(getRustKernel().browser_metadata_registry_forget_tab_indexes(json(entries), integer(tabId)));
}

/** Returns entry positions that a released client must evict. */
export function registryForgetClientIndexes(
  entries: readonly RegistryEntryMetadata[],
  clientId: string,
): number[] {
  return decode(getRustKernel().browser_metadata_registry_forget_client_indexes(json(entries), json(clientId)));
}

/** Validates a pacing profile and clamps only finite numeric overrides. */
export function planPacingInput(
  profile: unknown,
  minGapMs: unknown,
  jitterMs: unknown,
): PaceInputPlan {
  return decode(
    getRustKernel().browser_metadata_plan_pacing_input(
      json(describeValue(profile)),
      json(describeValue(minGapMs)),
      json(describeValue(jitterMs)),
    ),
  );
}

/** Returns source positions stably ordered by `windowId ?? 0`, then tab id. */
export function stableOwnedTabOrder(rows: readonly { windowId?: number; tabId: number }[]): number[] {
  return decode(
    getRustKernel().browser_metadata_owned_tab_order(
      json(rows.map((row, sourceIndex) => ({ sourceIndex, windowId: row.windowId, tabId: row.tabId }))),
    ),
  );
}

function navigationUrlFacts(raw: string): NavigationUrlFacts | null {
  try {
    const url = new URL(raw);
    return {
      protocol: url.protocol,
      host: url.host,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
    };
  } catch {
    return null;
  }
}

function describeValue(value: unknown):
  | { kind: 'undefined' }
  | { kind: 'string'; value: string }
  | { kind: 'finite-number'; value: number }
  | { kind: 'other' } {
  if (value === undefined) return { kind: 'undefined' };
  if (typeof value === 'string') return { kind: 'string', value };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { kind: 'finite-number', value };
  }
  return { kind: 'other' };
}

function json(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

function decode<T>(value: string): T {
  return JSON.parse(value) as T;
}

function integer(value: number): bigint {
  if (!Number.isSafeInteger(value)) throw new TypeError('WASM integer arguments must be safe integers');
  return BigInt(value);
}
