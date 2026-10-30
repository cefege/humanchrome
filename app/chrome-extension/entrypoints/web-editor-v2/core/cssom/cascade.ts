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
import {
  compareEditorCascade,
  compareEditorSourceOrder,
  computeEditorCascadeOverrides,
} from 'humanchrome-shared';

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
  return compareEditorSourceOrder(a, b);
}

export function compareCascade(a: DeclCandidate, b: DeclCandidate): number {
  return compareEditorCascade(a, b);
}

export function computeOverrides(candidates: readonly DeclCandidate[]): {
  winners: Map<string, DeclCandidate>;
  declStatus: Map<string, DeclStatus>;
} {
  const plan = computeEditorCascadeOverrides(candidates.map((candidate) => ({
    id: candidate.id,
    important: candidate.important,
    specificity: candidate.specificity,
    sourceOrder: candidate.sourceOrder,
    affects: candidate.affects,
  })));
  const winners = new Map(plan.winners.map(([property, index]) => [property, candidates[index]]));
  const declStatus = new Map<string, DeclStatus>(
    candidates.map((candidate) => [candidate.id, 'overridden']),
  );
  for (const id of plan.activeIds) declStatus.set(id, 'active');
  return { winners, declStatus };
}
