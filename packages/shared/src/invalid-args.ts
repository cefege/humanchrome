/**
 * Self-correcting envelope for INVALID_ARGS tool errors (IMP-0178).
 *
 * Without per-tool client-side JSONSchema (the IMP-0177 single-tool dispatcher
 * relies on this), the LLM has no static way to know the expected arg shape.
 * Every `INVALID_ARGS` response is therefore the model's one chance to learn
 * the right call without an extra round-trip. We carry four fields:
 *
 *   - arg       — which argument is wrong (existing convention; unchanged).
 *   - received  — what the caller actually sent (truncated; safe to surface).
 *   - expected  — the schema fragment the caller missed (an enum array, a
 *                 type name, a JSONSchema slice — whatever's most legible).
 *   - hint      — a one-line human-readable correction, often a "did you
 *                 mean ...?" suggestion produced by `didYouMean`.
 *
 * Backwards-compatible: `arg` is the only required field; old call sites that
 * pass only `{ arg }` continue to work, and old consumers that read only
 * `details.arg` keep working.
 */

export interface InvalidArgsDetails {
  arg: string;
  received?: unknown;
  expected?: unknown;
  hint?: string;
  [key: string]: unknown;
}

/** Cap surfaced values so an accidentally-stringified DOM doesn't blow the envelope. */
const MAX_RECEIVED_CHARS = 200;
export function truncateReceived(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_RECEIVED_CHARS
      ? value.slice(0, MAX_RECEIVED_CHARS) + '…'
      : value;
  }
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    const json = JSON.stringify(value);
    return json.length > MAX_RECEIVED_CHARS ? json.slice(0, MAX_RECEIVED_CHARS) + '…' : json;
  } catch {
    return String(value).slice(0, MAX_RECEIVED_CHARS);
  }
}

/**
 * Damerau-Levenshtein with early-out — sufficient for short enum candidates.
 * We cap maxDistance so the loop short-circuits the common "garbage input"
 * case (received="xyz", candidates=["start","stop"]) without quadratic work.
 */
function editDistance(a: string, b: string, maxDistance: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Return the closest candidate to `received` from `candidates`, or null if
 * nothing is within `maxDistance` edits. Case-insensitive — most enum typos
 * are case errors ("Start" vs "start") or single-character slips.
 */
export function didYouMean(
  received: unknown,
  candidates: readonly string[],
  maxDistance = 2,
): string | null {
  if (typeof received !== 'string' || candidates.length === 0) return null;
  const lower = received.toLowerCase();
  let best: string | null = null;
  let bestDist = maxDistance + 1;
  for (const c of candidates) {
    const d = editDistance(lower, c.toLowerCase(), maxDistance);
    if (d < bestDist) {
      bestDist = d;
      best = c;
      if (d === 0) break;
    }
  }
  return bestDist <= maxDistance ? best : null;
}

export interface BuildInvalidArgsOptions {
  arg: string;
  received?: unknown;
  expected?: unknown;
  /** Override the auto-generated `did you mean ...?` hint. */
  hint?: string;
  /** Enum candidates for didYouMean. Omit `hint` to auto-generate. */
  candidates?: readonly string[];
  /** Extra fields merged into the details object (e.g. matchCount, samples). */
  extra?: Record<string, unknown>;
}

export function buildInvalidArgsDetails(opts: BuildInvalidArgsOptions): InvalidArgsDetails {
  const { arg, received, expected, candidates, extra } = opts;
  let hint = opts.hint;
  if (!hint && candidates && candidates.length > 0) {
    const guess = didYouMean(received, candidates);
    if (guess) hint = `Did you mean "${guess}"?`;
  }
  const details: InvalidArgsDetails = { arg };
  if (received !== undefined) details.received = truncateReceived(received);
  if (expected !== undefined) {
    details.expected = expected;
  } else if (candidates && candidates.length > 0) {
    details.expected = { enum: [...candidates] };
  }
  if (hint) details.hint = hint;
  if (extra) Object.assign(details, extra);
  return details;
}

/**
 * Short alias for the most common call shape — INVALID_ARGS on an enum-typed
 * argument with auto-`hint`. Use directly when you have the candidate list.
 */
export function invalidArgsEnumDetails(
  arg: string,
  received: unknown,
  candidates: readonly string[],
  extra?: Record<string, unknown>,
): InvalidArgsDetails {
  return buildInvalidArgsDetails({ arg, received, candidates, extra });
}

