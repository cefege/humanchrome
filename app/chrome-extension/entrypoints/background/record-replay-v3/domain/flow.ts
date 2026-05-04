import type { ISODateTimeString, JsonObject } from './json';
import type { EdgeId, EdgeLabel, FlowId, NodeId } from './ids';
import type { FlowPolicy, NodePolicy } from './policy';
import type { VariableDefinition } from './variables';

export const FLOW_SCHEMA_VERSION = 3 as const;

export interface EdgeV3 {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  /** Used for conditional branches and error handling. */
  label?: EdgeLabel;
}

export type NodeKind = string;

export interface NodeV3 {
  id: NodeId;
  kind: NodeKind;
  name?: string;
  disabled?: boolean;
  policy?: NodePolicy;
  /** Config shape is determined by `kind`. */
  config: JsonObject;
  ui?: { x: number; y: number };
}

export interface FlowBinding {
  kind: 'domain' | 'path' | 'url';
  value: string;
}

export interface FlowV3 {
  schemaVersion: typeof FLOW_SCHEMA_VERSION;
  id: FlowId;
  name: string;
  description?: string;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;

  /** Explicit entry node — never inferred from in-degree. */
  entryNodeId: NodeId;
  nodes: NodeV3[];
  edges: EdgeV3[];

  variables?: VariableDefinition[];
  policy?: FlowPolicy;
  meta?: {
    tags?: string[];
    bindings?: FlowBinding[];
  };
}

export function findNodeById(flow: FlowV3, nodeId: NodeId): NodeV3 | undefined {
  return flow.nodes.find((n) => n.id === nodeId);
}

export function findEdgesFrom(flow: FlowV3, nodeId: NodeId): EdgeV3[] {
  return flow.edges.filter((e) => e.from === nodeId);
}

export function findEdgesTo(flow: FlowV3, nodeId: NodeId): EdgeV3[] {
  return flow.edges.filter((e) => e.to === nodeId);
}
