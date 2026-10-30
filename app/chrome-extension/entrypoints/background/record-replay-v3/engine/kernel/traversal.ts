import { workflowPolicy } from 'humanchrome-shared';
import type { NodeId, EdgeLabel } from '../../domain/ids';
import type { FlowV3, EdgeV3, NodeV3 } from '../../domain/flow';
import { RR_ERROR_CODES, createRRError, type RRError } from '../../domain/errors';

export type ValidateFlowDAGResult = { ok: true } | { ok: false; errors: RRError[] };
export type WorkflowTraversalContext = workflowPolicy.RustWorkflowContext;

/** Creates one indexed Rust workflow context for a flow execution or editor operation. */
export function createWorkflowTraversalContext(
  flow: FlowV3,
  variables: Record<string, workflowPolicy.JsonValue> = {},
): WorkflowTraversalContext {
  return new workflowPolicy.RustWorkflowContext(flow, variables);
}

function validationResult(context: WorkflowTraversalContext): ValidateFlowDAGResult {
  const validation = context.validateDag();
  if (validation.ok) return { ok: true };
  return {
    ok: false,
    errors: validation.errors.map((error) =>
      createRRError(
        error.code === 'DAG_CYCLE' ? RR_ERROR_CODES.DAG_CYCLE : RR_ERROR_CODES.DAG_INVALID,
        error.message,
      ),
    ),
  };
}

export function validateFlowDAG(flow: FlowV3): ValidateFlowDAGResult {
  return validationResult(createWorkflowTraversalContext(flow));
}

/** Returns the offending cycle path, or null when the DAG is acyclic. */
export function detectCycle(flow: FlowV3): NodeId[] | null {
  const cycle = createWorkflowTraversalContext(flow).detectCycle();
  return cycle === null ? null : (cycle as NodeId[]);
}

/**
 * Find the next node from `currentNodeId`. When `label` is omitted, the
 * default edge (or the sole outgoing edge) is used.
 */
export function findNextNode(
  flow: FlowV3,
  currentNodeId: NodeId,
  label?: EdgeLabel,
): NodeId | null {
  const nextNodeId = createWorkflowTraversalContext(flow).nextNode(currentNodeId, label);
  return nextNodeId === undefined ? null : (nextNodeId as NodeId);
}

/** Chooses the next node through an existing reusable Rust workflow context. */
export function findNextNodeInContext(
  context: WorkflowTraversalContext,
  currentNodeId: NodeId,
  label?: EdgeLabel,
): NodeId | null {
  const nextNodeId = context.nextNode(currentNodeId, label);
  return nextNodeId === undefined ? null : (nextNodeId as NodeId);
}


/** Returns the original node object selected through the indexed Rust workflow context. */
export function findNodeInContext(
  flow: FlowV3,
  context: WorkflowTraversalContext,
  nodeId: NodeId,
): NodeV3 | undefined {
  const index = context.nodeIndex(nodeId);
  return index === undefined ? undefined : flow.nodes[index];
}
export function findEdgeByLabel(
  flow: FlowV3,
  fromNodeId: NodeId,
  label: EdgeLabel,
): EdgeV3 | undefined {
  const context = createWorkflowTraversalContext(flow);
  const index = context.edgeIndexByLabel(fromNodeId, label);
  return index === undefined ? undefined : flow.edges[index];
}

export function findEdgeByLabelInContext(
  flow: FlowV3,
  context: WorkflowTraversalContext,
  fromNodeId: NodeId,
  label: EdgeLabel,
): EdgeV3 | undefined {
  const index = context.edgeIndexByLabel(fromNodeId, label);
  return index === undefined ? undefined : flow.edges[index];
}

export function getOutEdges(flow: FlowV3, nodeId: NodeId): EdgeV3[] {
  return createWorkflowTraversalContext(flow)
    .outEdgeIndexes(nodeId)
    .map((index) => flow.edges[index]);
}

export function getInEdges(flow: FlowV3, nodeId: NodeId): EdgeV3[] {
  return createWorkflowTraversalContext(flow)
    .inEdgeIndexes(nodeId)
    .map((index) => flow.edges[index]);
}

export function getReachableNodes(flow: FlowV3): Set<NodeId> {
  return new Set(createWorkflowTraversalContext(flow).reachableNodeIds() as NodeId[]);
}

export function isNodeReachable(flow: FlowV3, nodeId: NodeId): boolean {
  return getReachableNodes(flow).has(nodeId);
}