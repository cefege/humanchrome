/**
 * Selector stability and ordering policy is owned by the shared Rust kernel.
 *
 * The single-candidate helpers retain their synchronous public API for callers that need one
 * value. Batch callers must use `selectorPolicy.rankSelectorCandidates` or
 * `selectorPolicy.sortSelectorCandidates`, never this comparator in `Array#sort`.
 */

import { selectorPolicy } from 'humanchrome-shared';
import type { SelectorCandidate, SelectorStability } from './types';

export function computeSelectorStability(candidate: SelectorCandidate): SelectorStability {
  return selectorPolicy.rustSelectorStability(candidate);
}

export function withStability(candidate: SelectorCandidate): SelectorCandidate {
  if (candidate.stability) return candidate;
  return { ...candidate, stability: computeSelectorStability(candidate) } as SelectorCandidate;
}

/**
 * Legacy single-comparison compatibility.
 *
 * Production ordering must cross the kernel once for the complete candidate batch.
 */
export function compareSelectorCandidates(a: SelectorCandidate, b: SelectorCandidate): number {
  return selectorPolicy.compareRustSelectorCandidates(a, b);
}
