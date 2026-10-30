import type {
  WorkflowHandle as WasmWorkflowHandle,
  WorkflowUrlRules as WasmWorkflowUrlRules,
} from '../generated/humanchrome_wasm';
import { getRustKernel } from './rust-bindings';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface WorkflowNodeInput {
  id: string;
  kind: string;
  name?: string;
  disabled?: boolean;
  config?: JsonValue;
  ui?: { x: number; y: number };
}

export interface WorkflowEdgeInput {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface WorkflowFlowInput {
  id: string;
  entryNodeId: string;
  nodes?: WorkflowNodeInput[];
  edges?: WorkflowEdgeInput[];
}

export interface WorkflowValidationError {
  code: 'DAG_INVALID' | 'DAG_CYCLE';
  message: string;
}

export interface WorkflowValidation {
  ok: boolean;
  errors: WorkflowValidationError[];
}

export interface ConversionResult<T> {
  success: boolean;
  data?: T;
  errors: string[];
  warnings: string[];
}

export interface UrlMatchRule {
  kind: 'url' | 'domain' | 'path';
  value: string;
}

export interface RetryPolicyInput {
  intervalMs: number;
  maxIntervalMs?: number;
  backoff?: 'none' | 'linear' | 'exponential' | 'exp';
  jitter?: 'none' | 'full';
}

export type VariablePathSegment = string | number;

export interface VariableResolvable {
  kind: 'var';
  ref: { name: string; path?: VariablePathSegment[] };
  default?: JsonValue;
}

export interface ExpressionResolvable {
  kind: 'expr';
  expr: JsonValue;
  default?: JsonValue;
}

export interface TemplateTextPart {
  kind: 'text';
  value: string;
}

export interface TemplateInsertPart {
  kind: 'insert';
  value: Resolvable;
  format?: 'text' | 'json' | 'urlEncoded';
}

export interface TemplateResolvable {
  kind: 'template';
  parts: Array<TemplateTextPart | TemplateInsertPart | { kind: string; [key: string]: unknown }>;
}

export type Resolvable = JsonValue | VariableResolvable | ExpressionResolvable | TemplateResolvable;
export type ExpressionEvaluator = (expression: JsonValue) => JsonValue;

export type VariableOperation =
  | { op: 'set'; name: string; value?: JsonValue }
  | { op: 'delete'; name: string };

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function decode<T>(value: string): T {
  return JSON.parse(value) as T;
}

/** Reuses an indexed Rust flow and variable context across traversal and resolver decisions. */
export class RustWorkflowContext {
  readonly #handle: WasmWorkflowHandle;

  constructor(flow: WorkflowFlowInput, variables: Record<string, JsonValue>) {
    const kernel = getRustKernel();
    this.#handle = new kernel.WorkflowHandle(encode(flow), encode(variables));
  }

  nextNode(nodeId: string, label?: string): string | undefined {
    const result = this.#handle.next_node(nodeId, label === undefined ? undefined : encode(label));
    return result === undefined ? undefined : result;
  }

  nodeIndex(nodeId: string): number | undefined {
    return this.#handle.node_index(nodeId);
  }

  outEdgeIndexes(nodeId: string): number[] {
    return decode<number[]>(this.#handle.out_edge_indices(nodeId));
  }

  inEdgeIndexes(nodeId: string): number[] {
    return decode<number[]>(this.#handle.in_edge_indices(nodeId));
  }

  edgeIndexByLabel(nodeId: string, label: string): number | undefined {
    return this.#handle.edge_index_by_label(nodeId, encode(label));
  }

  detectCycle(): string[] | null {
    return decode<string[] | null>(this.#handle.detect_cycle());
  }

  reachableNodeIds(): string[] {
    return decode<string[]>(this.#handle.reachable_node_ids());
  }

  validateDag(): WorkflowValidation {
    return decode<WorkflowValidation>(this.#handle.validate_dag());
  }

  resolveJson(value: Resolvable, evaluate: ExpressionEvaluator): JsonValue {
    return decode<JsonValue>(this.#handle.resolve_json(encode(value), evaluate));
  }

  resolveString(value: Resolvable, evaluate: ExpressionEvaluator): string {
    return decode<string>(this.#handle.resolve_string(encode(value), evaluate));
  }

  resolveNumber(value: Resolvable, evaluate: ExpressionEvaluator): number {
    return this.#handle.resolve_number(encode(value), evaluate);
  }

  applyVariablePatch(patch: Record<string, JsonValue>): void {
    this.#handle.apply_variable_patch(encode(patch));
  }

  applyVariableOperations(operations: VariableOperation[]): void {
    this.#handle.apply_variable_operations(encode(operations));
  }
}

/** Reuses one Rust-compiled URL trigger rule set across navigation events. */
export class RustWorkflowUrlRules {
  readonly #handle: WasmWorkflowUrlRules;

  constructor(rules: UrlMatchRule[]) {
    const kernel = getRustKernel();
    this.#handle = new kernel.WorkflowUrlRules(encode(rules));
  }

  matches(url: string): boolean {
    return this.#handle.matches(encode(url));
  }
}

/** Converts a legacy V2 flow using Rust importer policy and browser string intrinsics. */
export function convertWorkflowV2ToV3<T>(flow: JsonValue, conversionTime: string): ConversionResult<T> {
  return decode<ConversionResult<T>>(getRustKernel().workflow_convert_v2_to_v3(encode(flow), encode(conversionTime)));
}

/** Converts a V3 flow to the legacy builder format through Rust policy. */
export function convertWorkflowV3ToV2<T>(flow: JsonValue): ConversionResult<T> {
  return decode<ConversionResult<T>>(getRustKernel().workflow_convert_v3_to_v2(encode(flow)));
}

/** Converts one V2 trigger, retaining weekly omitted-vs-empty day behavior. */
export function convertWorkflowV2Trigger<T>(trigger: JsonValue): ConversionResult<T> {
  return decode<ConversionResult<T>>(getRustKernel().workflow_convert_v2_trigger(encode(trigger)));
}

/** Compiles and matches URL trigger policy through Rust with browser URL/String semantics. */
export function workflowUrlMatches(rules: UrlMatchRule[], url: string): boolean {
  return getRustKernel().workflow_url_matches(encode(rules), encode(url));
}

/** Computes a timer-free V3 retry delay from supplied attempt and random inputs. */
export function workflowRetryDelay(policy: RetryPolicyInput, attempt: number, randomSample: number): number {
  return getRustKernel().workflow_retry_delay(encode(policy), attempt, randomSample);
}



function legacyWorkflowKernel() { return getRustKernel(); }

/** Expands legacy braces recursively while retaining opaque JavaScript values as handles. */
export function workflowLegacyExpandTemplatesDeep<T>(
  value: T,
  scope: Record<string, unknown>,
): T {
  return legacyWorkflowKernel().workflow_legacy_expand_templates_deep(value, scope) as T;
}

/** Applies legacy numeric-bracket assignment paths without serializing source or target values. */
export function workflowLegacyApplyAssign(
  target: Record<string, unknown>,
  source: unknown,
  assign: Record<string, unknown>,
): void {
  legacyWorkflowKernel().workflow_legacy_apply_assign(target, source, assign);
}

/** Reads the action-handler dot/bracket grammar, preserving JavaScript undefined. */
export function workflowLegacyHandlerLookup<T>(source: unknown, path: string): T | undefined {
  return legacyWorkflowKernel().workflow_legacy_handler_lookup(source, path) as T | undefined;
}

/** Matches legacy URL triggers using raw prefixes and hostname substring behavior. */
export function workflowLegacyUrlMatches(rules: UrlMatchRule[], url: string): boolean {
  return legacyWorkflowKernel().workflow_legacy_url_matches(rules, url);
}

/** Computes the legacy zero-based retry delay from the host's random sample. */
export function workflowLegacyRetryDelay(
  policy: Pick<RetryPolicyInput, 'intervalMs' | 'maxIntervalMs' | 'backoff' | 'jitter'>,
  retryIndex: number,
  randomSample: number,
): number {
  return legacyWorkflowKernel().workflow_legacy_retry_delay(policy, retryIndex, randomSample);
}

