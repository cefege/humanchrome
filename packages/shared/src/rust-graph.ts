import { getRustKernel } from './rust-bindings';

export type GraphNodeInput = { id: string; type: string };
export type GraphEdgeInput = { from: string; to: string; label?: unknown };

type NumberProjection =
  | { kind: 'finite'; value: number }
  | { kind: 'nan' }
  | { kind: 'infinity' }
  | { kind: '-infinity' };

type DelayProjection = { nullish: true } | ({ nullish: false } & NumberProjection);



export interface LegacyExecutionPlan {
  hasCycle: boolean;
  defaultEdgeIndexes: number[];
  orderedNodeIndexes: number[];
  executableNodeIndexes: number[];
  startNodeIndex: number | null;
}

export interface LegacyStepPlan {
  id: string;
  type: string;
  delay: boolean;
  sleep: number | 'nan' | 'infinity' | '-infinity' | null;
  normalize: Array<'target' | 'start' | 'end'>;
}

export interface LegacyNodePlan {
  id: string;
  type: string;
}

export interface LegacyGeneratedEdge {
  id: string;
  from: string;
  to: string;
  label: 'default';
}

export interface LegacyFlowNormalizationPlan {
  convertSteps: boolean;
  validEdgeIndexes: number[];
  useGeneratedEdges: boolean;
}

function kernel() { return getRustKernel(); }

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function decode<T>(value: string): T {
  return JSON.parse(value) as T;
}

function graphNodes(nodes: readonly GraphNodeInput[]) {
  return nodes.map((node) => ({ id: node.id, type: node.type }));
}

function graphEdges(edges: readonly GraphEdgeInput[]) {
  return edges.map((edge) => {
    const label = edge.label;
    return {
      from: edge.from,
      to: edge.to,
      label: typeof label === 'string' ? label : undefined,
      // This is a host-language intrinsic observation, not graph policy. Rust decides which
      // projected edges comprise the legacy execution/default graph.
      default: !label || label === 'default',
    };
  });
}

function sourceConfig(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function numberProjection(value: unknown): DelayProjection {
  if (value === undefined || value === null) return { nullish: true };
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return { nullish: false, kind: 'nan' };
  if (numeric === Infinity) return { nullish: false, kind: 'infinity' };
  if (numeric === -Infinity) return { nullish: false, kind: '-infinity' };
  return { nullish: false, kind: 'finite', value: numeric };
}

function propertyObservations(value: unknown) {
  const config = sourceConfig(value);
  return Object.fromEntries(
    ['target', 'start', 'end'].map((property) => {
      const field = config?.[property];
      return [property, { truthy: Boolean(field), object: typeof field === 'object' }];
    }),
  );
}

/** Orders source positions through Rust while retaining original caller-owned node objects. */
export function legacyTopoOrderIndexes(
  nodes: readonly GraphNodeInput[],
  edges: readonly GraphEdgeInput[],
): number[] {
  return decode<number[]>(
    kernel().graph_legacy_topo_order_indexes(encode(graphNodes(nodes)), encode(graphEdges(edges))),
  );
}

/** Orders legacy linear steps through Rust, including the empty-edge source-order quirk. */
export function legacyNodesToStepIndexes(
  nodes: readonly GraphNodeInput[],
  edges: readonly GraphEdgeInput[],
): number[] {
  return decode<number[]>(
    kernel().graph_legacy_nodes_to_step_indexes(encode(graphNodes(nodes)), encode(graphEdges(edges))),
  );
}

/** Selects the builder's executable linear projection through Rust-owned default/trigger policy. */
export function legacyBuilderStepIndexes(
  nodes: readonly GraphNodeInput[],
  edges: readonly GraphEdgeInput[],
): number[] {
  return decode<number[]>(
    kernel().graph_legacy_builder_step_indexes(encode(graphNodes(nodes)), encode(graphEdges(edges))),
  );
}
/** Runs all scheduler default-edge/order/cycle/start decisions in the Rust graph owner. */
export function legacyExecutionPlan(
  nodes: readonly GraphNodeInput[],
  edges: readonly GraphEdgeInput[],
): LegacyExecutionPlan {
  return decode<LegacyExecutionPlan>(
    kernel().graph_legacy_execution_plan(encode(graphNodes(nodes)), encode(graphEdges(edges))),
  );
}

/** Returns the first legacy matching-label edge, falling back to the Rust-selected default edge. */
export function legacyNextEdgeIndex(
  edges: readonly GraphEdgeInput[],
  currentId: string,
  label: string,
): number | undefined {
  return kernel().graph_legacy_next_edge(encode(graphEdges(edges)), encode(currentId), encode(label));
}

/** Selects an exact branch edge through Rust without default-edge fallback. */
export function legacyLabeledEdgeIndex(
  edges: readonly GraphEdgeInput[],
  currentId: string,
  label: string,
): number | undefined {
  return kernel().graph_legacy_labeled_edge(encode(graphEdges(edges)), encode(currentId), encode(label));
}

/** Returns a trigger node's Rust-selected default successor edge. */
export function legacyDefaultSuccessorEdgeIndex(
  edges: readonly GraphEdgeInput[],
  currentId: string,
): number | undefined {
  return kernel().graph_legacy_default_successor(encode(graphEdges(edges)), encode(currentId));
}

/** Produces a Rust-owned step patch while retaining the original config object for reattachment. */
export function legacyNodeToStepPlan(node: GraphNodeInput & { config?: unknown }): LegacyStepPlan {
  const isDelay = node.type === 'delay';
  const config = sourceConfig(node.config);
  const plan = decode<LegacyStepPlan>(
    kernel().graph_legacy_node_to_step_plan(
      encode({
        id: node.id,
        type: node.type,
        properties: isDelay ? {} : propertyObservations(node.config),
        delay: { sleep: { nullish: true }, ms: { nullish: true } },
      }),
    ),
  );
  if (!isDelay) return plan;

  const sleep = config?.sleep;
  const sleepIsNullish = sleep === undefined || sleep === null;
  const ms = sleepIsNullish ? config?.ms : undefined;
  const msIsNullish = ms === undefined || ms === null;
  const source = kernel().graph_legacy_delay_source(sleepIsNullish, msIsNullish);
  const selected = source === 'sleep' ? sleep : source === 'ms' ? ms : 1_000;
  plan.sleep = decode<LegacyStepPlan['sleep']>(
    kernel().graph_legacy_normalize_delay(encode(numberProjection(selected))),
  );
  return plan;
}

/** Produces Rust-owned legacy node IDs/types from host-observed string fields. */
export function legacyStepsToNodePlans(steps: ReadonlyArray<unknown>): LegacyNodePlan[] {
  return decode<LegacyNodePlan[]>(
    kernel().graph_legacy_steps_to_nodes_plan(
      encode(
        Array.from(steps, (step) => {
          const source = sourceConfig(step);
          return {
            id: typeof source?.id === 'string' ? source.id : undefined,
            type: typeof source?.type === 'string' ? source.type : undefined,
          };
        }),
      ),
    ),
  );
}

/** Generates Rust-owned sequential edge IDs from source node identities. */
export function legacySequentialEdges(nodes: readonly GraphNodeInput[]): LegacyGeneratedEdge[] {
  return decode<LegacyGeneratedEdge[]>(kernel().graph_legacy_sequential_edges(encode(graphNodes(nodes))));
}

/** Returns source edge indexes whose endpoints remain in the Rust-owned node projection. */
export function legacyValidEdgeIndexes(
  nodes: readonly GraphNodeInput[],
  edges: readonly GraphEdgeInput[],
): number[] {
  return decode<number[]>(
    kernel().graph_legacy_valid_edge_indexes(encode(graphNodes(nodes)), encode(graphEdges(edges))),
  );
}

/** Selects Rust-owned legacy flow normalization without copying original flow resources. */
export function legacyFlowNormalizationPlan(
  hasNodes: boolean,
  hasSteps: boolean,
  nodes: readonly GraphNodeInput[],
  edges: readonly GraphEdgeInput[],
): LegacyFlowNormalizationPlan {
  return decode<LegacyFlowNormalizationPlan>(
    kernel().graph_legacy_flow_normalization_plan(
      hasNodes,
      hasSteps,
      encode(graphNodes(nodes)),
      encode(graphEdges(edges)),
    ),
  );
}

/** Applies a Rust plan's non-finite number marker at the JavaScript resource boundary. */
export function legacyPlanNumber(value: LegacyStepPlan['sleep']): number | undefined {
  if (typeof value === 'number') return value;
  if (value === 'nan') return NaN;
  if (value === 'infinity') return Infinity;
  if (value === '-infinity') return -Infinity;
  return undefined;
}
