/** Bidirectional V2 ↔ V3 data converter. */

import type { FlowV3, NodeV3, EdgeV3, FlowBinding } from '../../domain/flow';
import type { TriggerSpec } from '../../domain/triggers';
import type { VariableDefinition } from '../../domain/variables';
import type { NodeId, FlowId, EdgeId } from '../../domain/ids';
import type { ISODateTimeString } from '../../domain/json';
import { FLOW_SCHEMA_VERSION } from '../../domain/flow';

// ==================== V2 Types (imported from record-replay) ====================

/** V2 Node type definition */
interface V2Node {
  id: string;
  type: string;
  name?: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
  ui?: { x: number; y: number };
}

/** V2 Edge type definition */
interface V2Edge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

/** V2 Variable definition */
interface V2VariableDef {
  key: string;
  label?: string;
  sensitive?: boolean;
  default?: unknown;
  type?: string;
  rules?: { required?: boolean; pattern?: string; enum?: string[] };
}

/** V2 Flow binding */
interface V2Binding {
  type: 'domain' | 'path' | 'url';
  value: string;
}

/** V2 Flow definition */
interface V2Flow {
  id: string;
  name: string;
  description?: string;
  version: number;
  meta?: {
    createdAt?: string;
    updatedAt?: string;
    domain?: string;
    tags?: string[];
    bindings?: V2Binding[];
    tool?: { category?: string; description?: string };
    exposedOutputs?: Array<{ nodeId: string; as: string }>;
  };
  variables?: V2VariableDef[];
  nodes?: V2Node[];
  edges?: V2Edge[];
  subflows?: Record<string, { nodes: V2Node[]; edges: V2Edge[] }>;
}

// ==================== Conversion Result Types ====================

export interface ConversionResult<T> {
  success: boolean;
  data?: T;
  errors: string[];
  warnings: string[];
}

// ==================== V2 -> V3 Conversion ====================

export function convertFlowV2ToV3(v2Flow: V2Flow): ConversionResult<FlowV3> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!v2Flow.id) {
    errors.push('V2 Flow missing required field: id');
  }
  if (!v2Flow.name) {
    errors.push('V2 Flow missing required field: name');
  }
  if (!v2Flow.nodes || v2Flow.nodes.length === 0) {
    errors.push('V2 Flow has no nodes');
  }

  if (v2Flow.subflows && Object.keys(v2Flow.subflows).length > 0) {
    errors.push(
      'V3 does not support subflows yet. Flow contains subflows: ' +
        Object.keys(v2Flow.subflows).join(', '),
    );
  }

  const unsupportedNodes = (v2Flow.nodes || []).filter(
    (n) => n.type === 'foreach' || n.type === 'while',
  );
  if (unsupportedNodes.length > 0) {
    errors.push(
      'V3 does not support foreach/while nodes yet. Found: ' +
        unsupportedNodes.map((n) => `${n.id} (${n.type})`).join(', '),
    );
  }

  if (errors.length > 0) {
    return { success: false, errors, warnings };
  }

  const nodes: NodeV3[] = [];
  for (const v2Node of v2Flow.nodes || []) {
    const node = convertNodeV2ToV3(v2Node);
    if (node) {
      nodes.push(node);
    } else {
      warnings.push(`Skipped invalid node: ${v2Node.id}`);
    }
  }

  const edges: EdgeV3[] = [];
  for (const v2Edge of v2Flow.edges || []) {
    const edge = convertEdgeV2ToV3(v2Edge);
    if (edge) {
      edges.push(edge);
    } else {
      warnings.push(`Skipped invalid edge: ${v2Edge.id}`);
    }
  }

  const entryResult = findEntryNodeId(nodes, edges);
  warnings.push(...entryResult.warnings);
  if (!entryResult.nodeId) {
    errors.push('Could not determine entry node. No valid root node found.');
    return { success: false, errors, warnings };
  }
  const entryNodeId = entryResult.nodeId;

  const variables = convertVariablesV2ToV3(v2Flow.variables || []);

  const meta = convertMetaV2ToV3(v2Flow.meta);

  const now = new Date().toISOString() as ISODateTimeString;
  const v3Flow: FlowV3 = {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id: v2Flow.id as FlowId,
    name: v2Flow.name,
    createdAt: (v2Flow.meta?.createdAt as ISODateTimeString) || now,
    updatedAt: (v2Flow.meta?.updatedAt as ISODateTimeString) || now,
    entryNodeId,
    nodes,
    edges,
  };

  if (v2Flow.description) {
    v3Flow.description = v2Flow.description;
  }
  if (variables.length > 0) {
    v3Flow.variables = variables;
  }
  if (meta) {
    v3Flow.meta = meta;
  }

  return { success: true, data: v3Flow, errors, warnings };
}

function convertNodeV2ToV3(v2Node: V2Node): NodeV3 | null {
  if (!v2Node.id || !v2Node.type) {
    return null;
  }

  const node: NodeV3 = {
    id: v2Node.id as NodeId,
    kind: v2Node.type, // V2 type -> V3 kind
    config: (v2Node.config as Record<string, unknown>) || {},
  };

  if (v2Node.name) {
    node.name = v2Node.name;
  }
  if (v2Node.disabled) {
    node.disabled = v2Node.disabled;
  }
  if (v2Node.ui) {
    node.ui = v2Node.ui;
  }

  return node;
}

function convertEdgeV2ToV3(v2Edge: V2Edge): EdgeV3 | null {
  if (!v2Edge.id || !v2Edge.from || !v2Edge.to) {
    return null;
  }

  const edge: EdgeV3 = {
    id: v2Edge.id as EdgeId,
    from: v2Edge.from as NodeId,
    to: v2Edge.to as NodeId,
  };

  if (v2Edge.label) {
    edge.label = v2Edge.label as EdgeV3['label'];
  }

  return edge;
}

interface EntryNodeResult {
  nodeId: NodeId | null;
  warnings: string[];
}

/**
 * Determine the entry node for an imported V2 flow.
 *
 * 1. Exclude `trigger` nodes — they are UI metadata, not part of execution.
 * 2. Compute in-degree using only edges between executable nodes.
 * 3. Pick a node with in-degree 0 as the entry candidate.
 * 4. Tie-break with `selectStableRootNode` (UI top-left, then ID lexicographic).
 */
function findEntryNodeId(nodes: NodeV3[], edges: EdgeV3[]): EntryNodeResult {
  const warnings: string[] = [];

  const executableNodes = nodes.filter((n) => n.kind !== 'trigger');
  if (executableNodes.length === 0) {
    warnings.push('No executable nodes found; cannot determine entry node');
    return { nodeId: null, warnings };
  }

  const executableNodeIds = new Set<NodeId>(executableNodes.map((n) => n.id));

  const inDegree = new Map<NodeId, number>();
  for (const node of executableNodes) {
    inDegree.set(node.id, 0);
  }
  for (const edge of edges) {
    if (!executableNodeIds.has(edge.from)) {
      continue;
    }
    if (!executableNodeIds.has(edge.to)) {
      continue;
    }
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const rootNodes = executableNodes.filter((n) => inDegree.get(n.id) === 0);

  if (rootNodes.length === 0) {
    // Graph has a cycle — fall back to a stable selection.
    const fallbackResult = selectStableRootNode(executableNodes);
    warnings.push(
      `No inDegree=0 executable node found (graph may contain cycles); ` +
        `falling back to "${fallbackResult.node.id}" by ${fallbackResult.rule}`,
    );
    return { nodeId: fallbackResult.node.id, warnings };
  }

  if (rootNodes.length === 1) {
    return { nodeId: rootNodes[0].id, warnings };
  }

  const selectedResult = selectStableRootNode(rootNodes);
  const candidateIds = rootNodes
    .map((n) => n.id)
    .sort((a, b) => a.localeCompare(b))
    .join(', ');
  warnings.push(
    `Multiple inDegree=0 executable nodes (${candidateIds}); ` +
      `selected "${selectedResult.node.id}" by ${selectedResult.rule}`,
  );

  return { nodeId: selectedResult.node.id, warnings };
}

interface StableSelectionResult {
  node: NodeV3;
  rule: string;
}

/** Pick a deterministic entry node: UI top-left first, otherwise smallest ID. */
function selectStableRootNode(nodes: NodeV3[]): StableSelectionResult {
  const hasValidUi = (n: NodeV3): n is NodeV3 & { ui: { x: number; y: number } } =>
    !!n.ui && Number.isFinite(n.ui.x) && Number.isFinite(n.ui.y);

  const nodesWithUi = nodes.filter(hasValidUi);

  if (nodesWithUi.length > 0) {
    // Sort by x asc, then y asc, then id asc as tie-breaker.
    nodesWithUi.sort((a, b) => {
      if (a.ui.x !== b.ui.x) return a.ui.x - b.ui.x;
      if (a.ui.y !== b.ui.y) return a.ui.y - b.ui.y;
      return a.id.localeCompare(b.id);
    });
    const selected = nodesWithUi[0];
    return {
      node: selected,
      rule: `ui(x=${selected.ui.x}, y=${selected.ui.y})`,
    };
  }

  const sortedById = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  return { node: sortedById[0], rule: 'id' };
}

function convertVariablesV2ToV3(v2Variables: V2VariableDef[]): VariableDefinition[] {
  return v2Variables
    .filter((v) => v.key)
    .map((v) => {
      const variable: VariableDefinition = {
        name: v.key,
      };

      if (v.label) {
        variable.label = v.label;
      }
      if (v.sensitive) {
        variable.sensitive = v.sensitive;
      }
      if (v.default !== undefined) {
        variable.default = v.default;
      }
      if (v.rules?.required) {
        variable.required = v.rules.required;
      }

      return variable;
    });
}

function convertMetaV2ToV3(v2Meta: V2Flow['meta']): FlowV3['meta'] | undefined {
  if (!v2Meta) return undefined;

  const meta: FlowV3['meta'] = {};

  if (v2Meta.tags && v2Meta.tags.length > 0) {
    meta.tags = v2Meta.tags;
  }

  if (v2Meta.bindings && v2Meta.bindings.length > 0) {
    meta.bindings = v2Meta.bindings.map((b) => ({
      kind: b.type, // V2 type -> V3 kind
      value: b.value,
    }));
  }

  if (Object.keys(meta).length === 0) {
    return undefined;
  }

  return meta;
}

/** Convert a V3 Flow back to V2 (for editing in the legacy V2 builder). */
export function convertFlowV3ToV2(v3Flow: FlowV3): ConversionResult<V2Flow> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const nodes: V2Node[] = v3Flow.nodes.map((n) => ({
    id: n.id,
    type: n.kind, // V3 kind -> V2 type
    name: n.name,
    disabled: n.disabled,
    config: n.config as Record<string, unknown>,
    ui: n.ui,
  }));

  const edges: V2Edge[] = v3Flow.edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    label: e.label,
  }));

  const variables: V2VariableDef[] = (v3Flow.variables || []).map((v) => ({
    key: v.name,
    label: v.label,
    sensitive: v.sensitive,
    default: v.default,
    rules: v.required ? { required: v.required } : undefined,
  }));

  const meta: V2Flow['meta'] = {
    createdAt: v3Flow.createdAt,
    updatedAt: v3Flow.updatedAt,
  };

  if (v3Flow.meta?.tags) {
    meta.tags = v3Flow.meta.tags;
  }

  if (v3Flow.meta?.bindings) {
    meta.bindings = v3Flow.meta.bindings.map((b) => ({
      type: b.kind, // V3 kind -> V2 type
      value: b.value,
    }));
  }

  const v2Flow: V2Flow = {
    id: v3Flow.id,
    name: v3Flow.name,
    description: v3Flow.description,
    version: 2,
    meta,
    variables: variables.length > 0 ? variables : undefined,
    nodes,
    edges,
  };

  return { success: true, data: v2Flow, errors, warnings };
}

// ==================== Trigger Conversion ====================

interface V2Trigger {
  id: string;
  type: 'url' | 'command' | 'manual' | 'schedule' | 'element';
  flowId: string;
  enabled?: boolean;
  match?: Array<{ kind: string; value: string }>;
  title?: string;
  commandKey?: string;
  selector?: string;
  appear?: boolean;
  once?: boolean;
  debounceMs?: number;
  schedule?: {
    type: 'interval' | 'daily' | 'weekly';
    intervalMs?: number;
    time?: string;
    days?: number[];
  };
}

export function convertTriggerV2ToV3(v2Trigger: V2Trigger): ConversionResult<TriggerSpec> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!v2Trigger.id) {
    errors.push('V2 Trigger missing required field: id');
  }
  if (!v2Trigger.flowId) {
    errors.push('V2 Trigger missing required field: flowId');
  }
  if (!v2Trigger.type) {
    errors.push('V2 Trigger missing required field: type');
  }

  if (errors.length > 0) {
    return { success: false, errors, warnings };
  }

  let trigger: TriggerSpec;

  switch (v2Trigger.type) {
    case 'manual':
      trigger = {
        id: v2Trigger.id,
        kind: 'manual',
        flowId: v2Trigger.flowId as FlowId,
        enabled: v2Trigger.enabled ?? true,
      };
      break;

    case 'command':
      trigger = {
        id: v2Trigger.id,
        kind: 'command',
        flowId: v2Trigger.flowId as FlowId,
        enabled: v2Trigger.enabled ?? true,
        command: v2Trigger.commandKey || 'run_workflow',
      };
      break;

    case 'url':
      trigger = {
        id: v2Trigger.id,
        kind: 'url',
        flowId: v2Trigger.flowId as FlowId,
        enabled: v2Trigger.enabled ?? true,
        patterns: (v2Trigger.match || []).map((m) => m.value),
      };
      break;

    case 'schedule': {
      const cron = convertScheduleToCron(v2Trigger.schedule);
      if (!cron) {
        errors.push('Could not convert V2 schedule to cron expression');
        return { success: false, errors, warnings };
      }
      trigger = {
        id: v2Trigger.id,
        kind: 'cron',
        flowId: v2Trigger.flowId as FlowId,
        enabled: v2Trigger.enabled ?? true,
        cron,
      };
      break;
    }

    case 'element':
      warnings.push('Element trigger is not fully supported in V3, converting to manual');
      trigger = {
        id: v2Trigger.id,
        kind: 'manual',
        flowId: v2Trigger.flowId as FlowId,
        enabled: v2Trigger.enabled ?? true,
      };
      break;

    default:
      errors.push(`Unknown V2 trigger type: ${v2Trigger.type}`);
      return { success: false, errors, warnings };
  }

  return { success: true, data: trigger, errors, warnings };
}

function convertScheduleToCron(schedule: V2Trigger['schedule']): string | null {
  if (!schedule) return null;

  switch (schedule.type) {
    case 'interval': {
      const intervalMinutes = Math.max(1, Math.round((schedule.intervalMs || 60000) / 60000));
      if (intervalMinutes < 60) {
        return `*/${intervalMinutes} * * * *`;
      } else {
        const hours = Math.round(intervalMinutes / 60);
        return `0 */${hours} * * *`;
      }
    }

    case 'daily':
      if (schedule.time) {
        const [hour, minute] = schedule.time.split(':').map(Number);
        return `${minute || 0} ${hour || 0} * * *`;
      }
      return '0 0 * * *';

    case 'weekly': {
      const days = (schedule.days || [0]).join(',');
      if (schedule.time) {
        const [hour, minute] = schedule.time.split(':').map(Number);
        return `${minute || 0} ${hour || 0} * * ${days}`;
      }
      return `0 0 * * ${days}`;
    }

    default:
      return null;
  }
}

export interface V2ToV3Converter {
  convertFlow(v2Flow: unknown): FlowV3;
  convertTrigger(v2Trigger: unknown): TriggerSpec;
}

export function createV2ToV3Converter(): V2ToV3Converter {
  return {
    convertFlow(v2Flow: unknown): FlowV3 {
      const result = convertFlowV2ToV3(v2Flow as V2Flow);
      if (!result.success || !result.data) {
        throw new Error(`Flow conversion failed: ${result.errors.join('; ')}`);
      }
      return result.data;
    },

    convertTrigger(v2Trigger: unknown): TriggerSpec {
      const result = convertTriggerV2ToV3(v2Trigger as V2Trigger);
      if (!result.success || !result.data) {
        throw new Error(`Trigger conversion failed: ${result.errors.join('; ')}`);
      }
      return result.data;
    },
  };
}

/** @deprecated Use createV2ToV3Converter() instead. */
export function createNotImplementedV2ToV3Converter(): V2ToV3Converter {
  return createV2ToV3Converter();
}
