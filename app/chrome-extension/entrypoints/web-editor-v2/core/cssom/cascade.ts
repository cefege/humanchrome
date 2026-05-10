/**
 * Cascade computation (IMP-0046 slice 5, completes IMP).
 *
 * Sorts declaration candidates by the CSS spec's three-key ordering:
 *   1. !important wins over !regular
 *   2. higher specificity wins
 *   3. later source-order wins
 *
 * Then `computeOverrides` walks the sorted candidates and assigns each
 * `active` (winner) or `overridden` (loser) status per longhand property.
 *
 * Pure functions over typed candidates — no DOM, no CSSOM access.
 */
import type { DeclStatus, Specificity } from '../cssom-styles-collector';
import { compareSpecificity } from './specificity-parser';

/**
 * A flattened declaration with the full information needed to participate
 * in the cascade. `affects` lists the longhand properties this candidate
 * can win (a single shorthand declaration may compete on many longhands).
 */
export interface DeclCandidate {
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

export function compareSourceOrder(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  if (a[0] !== b[0]) return a[0] > b[0] ? 1 : -1;
  if (a[1] !== b[1]) return a[1] > b[1] ? 1 : -1;
  if (a[2] !== b[2]) return a[2] > b[2] ? 1 : -1;
  return 0;
}

export function compareCascade(a: DeclCandidate, b: DeclCandidate): number {
  if (a.important !== b.important) return a.important ? 1 : -1;
  const spec = compareSpecificity(a.specificity, b.specificity);
  if (spec !== 0) return spec;
  return compareSourceOrder(a.sourceOrder, b.sourceOrder);
}

export function computeOverrides(candidates: readonly DeclCandidate[]): {
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
