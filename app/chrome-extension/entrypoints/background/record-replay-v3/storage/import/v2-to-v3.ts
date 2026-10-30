/** Bidirectional V2 ↔ V3 data conversion delegated to the Rust workflow policy. */

import { workflowPolicy } from 'humanchrome-shared';
import type { FlowV3 } from '../../domain/flow';
import type { TriggerSpec } from '../../domain/triggers';

interface V2Node {
  id: string;
  type: string;
  name?: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
  ui?: { x: number; y: number };
}

interface V2Edge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

interface V2VariableDef {
  key: string;
  label?: string;
  sensitive?: boolean;
  default?: unknown;
  type?: string;
  rules?: { required?: boolean; pattern?: string; enum?: string[] };
}

interface V2Binding {
  type: 'domain' | 'path' | 'url';
  value: string;
}

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

export interface ConversionResult<T> {
  success: boolean;
  data?: T;
  errors: string[];
  warnings: string[];
}

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

function asJson(value: unknown): workflowPolicy.JsonValue {
  return value as workflowPolicy.JsonValue;
}

function v2PolicyFlow(flow: V2Flow): workflowPolicy.JsonValue {
  return asJson({
    id: flow.id,
    name: flow.name,
    version: flow.version,
    description: flow.description,
    meta: flow.meta && {
      createdAt: flow.meta.createdAt,
      updatedAt: flow.meta.updatedAt,
      tags: flow.meta.tags,
      bindings: flow.meta.bindings?.map(({ type, value }) => ({ type, value })),
    },
    variables: flow.variables?.map(({ default: _default, ...variable }) => variable),
    nodes: flow.nodes?.map(({ id, type, name, disabled, ui }) => ({
      id, type, name, disabled, ui,
    })),
    edges: flow.edges?.map(({ id, from, to, label }) => ({ id, from, to, label })),
    subflows: flow.subflows && Object.fromEntries(Object.keys(flow.subflows).map((key) => [key, {}])),
  });
}

function v3PolicyFlow(flow: FlowV3): workflowPolicy.JsonValue {
  return asJson({
    schemaVersion: flow.schemaVersion,
    id: flow.id,
    name: flow.name,
    description: flow.description,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    entryNodeId: flow.entryNodeId,
    variables: flow.variables?.map(({ default: _default, ...variable }) => variable),
    meta: flow.meta && {
      tags: flow.meta.tags,
      bindings: flow.meta.bindings?.map(({ kind, value }) => ({ kind, value })),
    },
    nodes: flow.nodes.map(({ id, kind, name, disabled, ui }) => ({
      id, kind, name, disabled, ui,
    })),
    edges: flow.edges.map(({ id, from, to, label }) => ({ id, from, to, label })),
  });
}

function retainV2NodeReferences(
  result: ConversionResult<FlowV3>,
  source: V2Flow,
): ConversionResult<FlowV3> {
  if (!result.success || !result.data) return result;

  let sourceIndex = 0;
  for (const converted of result.data.nodes) {
    while (sourceIndex < (source.nodes?.length ?? 0)) {
      const original = source.nodes![sourceIndex++];
      if (original.id !== converted.id || original.type !== converted.kind) continue;
      // Rust owns conversion and validation; retain opaque caller-owned payload objects.
      converted.name = original.name;
      converted.disabled = original.disabled;
      converted.config = original.config as unknown as typeof converted.config;
      converted.ui = original.ui;
      break;
    }
  }
  for (const converted of result.data.variables ?? []) {
    const original = source.variables?.find((variable) => variable.key === converted.name);
    if (original) converted.default = original.default as typeof converted.default;
  }
  return result;
}

function retainV3NodeReferences(
  result: ConversionResult<V2Flow>,
  source: FlowV3,
): ConversionResult<V2Flow> {
  if (!result.success || !result.data) return result;

  let sourceIndex = 0;
  for (const converted of result.data.nodes ?? []) {
    while (sourceIndex < source.nodes.length) {
      const original = source.nodes[sourceIndex++];
      if (original.id !== converted.id || original.kind !== converted.type) continue;
      converted.name = original.name;
      converted.disabled = original.disabled;
      converted.config = original.config;
      converted.ui = original.ui;
      break;
    }
  }
  for (const converted of result.data.variables ?? []) {
    const original = source.variables?.find((variable) => variable.name === converted.key);
    if (original) converted.default = original.default;
  }
  return result;
}

export function convertFlowV2ToV3(v2Flow: V2Flow): ConversionResult<FlowV3> {
  return retainV2NodeReferences(
    workflowPolicy.convertWorkflowV2ToV3<FlowV3>(
      v2PolicyFlow(v2Flow),
      new Date().toISOString(),
    ),
    v2Flow,
  );
}

/** Converts V3 flows back to the legacy builder shape through Rust policy. */
export function convertFlowV3ToV2(v3Flow: FlowV3): ConversionResult<V2Flow> {
  return retainV3NodeReferences(
    workflowPolicy.convertWorkflowV3ToV2<V2Flow>(v3PolicyFlow(v3Flow)),
    v3Flow,
  );
}

export function convertTriggerV2ToV3(v2Trigger: V2Trigger): ConversionResult<TriggerSpec> {
  return workflowPolicy.convertWorkflowV2Trigger<TriggerSpec>(asJson(v2Trigger));
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

export function createNotImplementedV2ToV3Converter(): V2ToV3Converter {
  return createV2ToV3Converter();
}
