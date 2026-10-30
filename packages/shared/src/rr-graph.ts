// rr-graph.ts — browser resource adapter for Rust-owned Record & Replay graph policy.

import type { EdgeLabel } from './labels';
import {
  legacyBuilderStepIndexes,
  legacyDefaultSuccessorEdgeIndex,
  legacyExecutionPlan,
  legacyLabeledEdgeIndex,
  legacyFlowNormalizationPlan,
  legacyNextEdgeIndex,
  legacyNodeToStepPlan,
  legacyNodesToStepIndexes,
  legacyPlanNumber,
  legacySequentialEdges,
  legacyStepsToNodePlans,
  legacyTopoOrderIndexes,
  legacyValidEdgeIndexes,
} from './rust-graph';

import { RR_STEP_TYPES } from './rr-step-types';


export { RR_STEP_TYPES } from './rr-step-types';
export type { RRStepType } from './rr-step-types';

export interface RRNode {
  id: string;
  type: string;
  config?: Record<string, unknown>;
}

export interface RREdge {
  id: string;
  from: string;
  to: string;
  label?: EdgeLabel;
}

function sourceConfig(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function applyNormalizedProperties(
  target: Record<string, unknown>,
  properties: ReadonlyArray<'target' | 'start' | 'end'>,
): Record<string, unknown> {
  for (const property of properties) target[property] = { candidates: [] };
  return target;
}

/**
 * Topological order using Rust-owned legacy Kahn traversal. Returned instances remain the
 * caller's originals, retaining opaque metadata and duplicate-id/cycle-fallback behavior.
 */
export function topoOrder<T extends RRNode>(nodes: T[], edges: RREdge[]): T[] {
  return legacyTopoOrderIndexes(nodes, edges).map((index) => nodes[index]);
}

/** Maps one V2 node to a legacy linear step through a Rust patch plus original config reattachment. */
export function mapNodeToStep(node: RRNode): Record<string, unknown> {
  if (node.type === RR_STEP_TYPES.DELAY) {
    const plan = legacyNodeToStepPlan(node);
    return {
      id: plan.id,
      type: plan.type,
      condition: { sleep: legacyPlanNumber(plan.sleep) },
    };
  }
  const step = { ...(sourceConfig(node.config) ?? {}) };
  const plan = legacyNodeToStepPlan({
    id: node.id,
    type: node.type,
    config: step,
  });
  step.id = plan.id;
  step.type = plan.type;
  return applyNormalizedProperties(step, plan.normalize);
}

/** Maps nodes to legacy linear steps after Rust selects the historical graph order. */
export function nodesToSteps(nodes: RRNode[], edges: RREdge[]): Record<string, unknown>[] {
  return legacyNodesToStepIndexes(nodes, edges).map((index) => mapNodeToStep(nodes[index]));
}

/** Removes step identity fields through a Rust patch while retaining opaque values by identity. */
export function mapStepToNodeConfig(step: unknown): Record<string, unknown> {
  const config = { ...(sourceConfig(step) ?? {}) };
  const plan = legacyNodeToStepPlan({
    id: '',
    type: '',
    config,
  });
  delete config.id;
  delete config.type;
  return applyNormalizedProperties(config, plan.normalize);
}

/** Converts legacy linear steps to V2 nodes with Rust-owned fallback identifiers and types. */
export function stepsToNodes(steps: ReadonlyArray<unknown>): RRNode[] {
  return legacyStepsToNodePlans(steps).map((plan, index) => ({
    id: plan.id,
    type: plan.type,
    config: mapStepToNodeConfig(steps[index]),
  }));
}

/** Converts legacy linear steps to a Rust-identified sequential DAG. */
export function stepsToDAG(steps: ReadonlyArray<unknown>): { nodes: RRNode[]; edges: RREdge[] } {
  const nodes = stepsToNodes(steps);
  return {
    nodes,
    edges: legacySequentialEdges(nodes),
  };
}

/** Exposes Rust's legacy execution and normalization decisions to browser effect adapters. */
export {
  legacyDefaultSuccessorEdgeIndex,
  legacyBuilderStepIndexes,
  legacyExecutionPlan,
  legacyFlowNormalizationPlan,
  legacyLabeledEdgeIndex,
  legacyNextEdgeIndex,
  legacyValidEdgeIndexes,
};
