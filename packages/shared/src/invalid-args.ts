/**
 * Self-correcting envelope for INVALID_ARGS tool errors (IMP-0178).
 *
 * JavaScript retains opaque values, `undefined`, JSON serialization, and property assignment;
 * the Rust policy kernel owns UTF-16 truncation and typo-ranking decisions.
 */
import { didYouMeanPolicy, truncateReceivedPolicy } from './rust-shared-policy';

export interface InvalidArgsDetails {
  arg: string;
  received?: unknown;
  expected?: unknown;
  hint?: string;
  [key: string]: unknown;
}

/** Cap surfaced values so an accidentally-stringified DOM doesn't blow the envelope. */
export function truncateReceived(value: unknown): unknown {
  return truncateReceivedPolicy(value);
}

/**
 * Return the closest candidate to `received` from `candidates`, or null if
 * nothing is within `maxDistance` edits.
 */
export function didYouMean(
  received: unknown,
  candidates: readonly string[],
  maxDistance = 2,
): string | null {
  return didYouMeanPolicy(received, candidates, maxDistance);
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
