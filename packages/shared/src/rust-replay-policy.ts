import { getRustKernel } from './rust-bindings';

export type ExecutionMode = 'legacy' | 'actions' | 'hybrid';

export interface ReplayExecutionModeSets {
  minimalHybridActionTypes: string[];
  migratedActionTypes: string[];
  needsValidationTypes: string[];
  legacyOnlyTypes: string[];
}

export interface ReplayForeachPlan {
  kind: 'foreach';
  listVar: string;
  itemVar: string;
  subflowId: string;
  concurrency: number;
}

export interface ReplayWhilePlan {
  kind: 'while';
  subflowId: string;
  maxIterations: number;
}

export type ReplayControlPlan = ReplayForeachPlan | ReplayWhilePlan;

export interface RecordedStepAppendPlan {
  previousNodeId: string | null;
  edgeId: string | null;
  edgeLabel: string;
}

export interface InitialFlowPlan {
  id: string;
  name: string;
  version: number;
  meta: Record<string, unknown>;
}

export interface RecordingEdgePlan {
  id: string;
  from: string;
  to: string;
  label: 'default';
}

export type RecordingOperation =
  | {
      kind: 'update';
      stepIndex: number;
      nodeIndex: number;
      nodeType: string;
      fallbackType: boolean;
    }
  | {
      kind: 'append';
      stepIndex: number;
      nodeIndex: number;
      nodeType: string;
      fallbackType: boolean;
      edge: RecordingEdgePlan | null;
    }
  | { kind: 'skip'; stepIndex: number };

export interface RecordingCachePlan {
  nodeIndexes: Array<[string, number]>;
  edgeSeq: number;
}

export interface RecordingAppendPlan {
  rechainBefore: RecordingEdgePlan[] | null;
  operations: RecordingOperation[];
  rechainAfter: RecordingEdgePlan[] | null;
  cache: RecordingCachePlan;
}


export interface RecordingNodeTypePlan {
  nodeType: string;
  fallbackType: boolean;
}

function encode(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

function decode<T>(value: string): T {
  return JSON.parse(value) as T;
}

/** Exposes the immutable routing sets from the portable replay policy. */
export function replayExecutionModeSets(): ReplayExecutionModeSets {
  return decode(getRustKernel().replay_execution_mode_sets());
}

/** Selects an action executor without inspecting action implementation callbacks. */
export function replayShouldUseActions(
  mode: ExecutionMode,
  stepType: string,
  legacyOnlyTypes: ReadonlySet<string> | undefined,
  actionsAllowlist: ReadonlySet<string> | undefined,
): boolean {
  return getRustKernel().replay_should_use_actions(
    mode,
    stepType,
    encode(legacyOnlyTypes === undefined ? null : [...legacyOnlyTypes]),
    encode(actionsAllowlist === undefined ? null : [...actionsAllowlist]),
  );
}

/** Computes the retained retry delay after JavaScript performs Number coercion. */
export function replayRetryDelayMs(base: number, backoff: string, attempt: number): number {
  return getRustKernel().replay_retry_delay_ms(base, backoff, attempt);
}

/** Applies the historical retry exhaustion comparison to host-coerced values. */
export function replayRetryExhausted(attempt: number, max: number): boolean {
  return getRustKernel().replay_retry_exhausted(attempt, max);
}


/** Computes ActionRegistry's total attempt count from retries-beyond-first. */
export function replayActionMaxAttempts(retries: number): number {
  return getRustKernel().replay_action_max_attempts(retries);
}

/** Normalizes a timeout value before the JavaScript host installs a timer. */
export function replayTimeoutMs(value: number): number {
  return getRustKernel().replay_timeout_ms(value);
}
/** Tests retry eligibility while preserving error payloads as opaque host values. */
export function replayShouldRetryAction(
  hasPolicy: boolean,
  retries: number,
  errorCode: string | undefined,
  retryOn: readonly string[] | undefined,
): boolean {
  return getRustKernel().replay_should_retry_action(
    hasPolicy,
    retries,
    errorCode,
    encode(retryOn === undefined ? null : retryOn),
  );
}

/** Validates and normalizes a foreach declaration without evaluating its subflow. */
export function replayForeachPlan(input: {
  listVar: unknown;
  itemVar: unknown;
  subflowId: unknown;
  concurrency: number;
}): ReplayForeachPlan {
  const { concurrency, ...shape } = input;
  return {
    ...decode<Omit<ReplayForeachPlan, 'concurrency'>>(
      getRustKernel().replay_foreach_plan(encode(shape), concurrency),
    ),
    concurrency: getRustKernel().replay_foreach_concurrency(concurrency),
  };
}

/** Validates and normalizes a while declaration without evaluating its condition. */
export function replayWhilePlan(input: {
  hasCondition: boolean;
  subflowId: unknown;
  maxIterations: number;
}): ReplayWhilePlan {
  const { maxIterations, ...shape } = input;
  return {
    ...decode<Omit<ReplayWhilePlan, 'maxIterations'>>(
      getRustKernel().replay_while_plan(encode(shape), maxIterations),
    ),
    maxIterations: getRustKernel().replay_while_max_iterations(maxIterations),
  };
}

/** Selects a branch after the host evaluates any requested JavaScript expressions. */
export function replayIfBranchLabel(
  labels: readonly string[],
  matchingIndex: number | undefined,
  hasElse: boolean,
  elseLabel: string,
): string {
  return getRustKernel().replay_if_branch_label(
    encode(labels),
    encode(matchingIndex ?? null),
    hasElse,
    elseLabel,
  );
}

/** Returns the legacy if validation error, retaining JavaScript condition evaluation in the host. */
export function replayValidateIf(hasBranches: boolean, hasCondition: boolean): string | undefined {
  return getRustKernel().replay_validate_if(hasBranches, hasCondition);
}

export type ReplayResolutionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** Resolves one legacy JSON value without serializing or cloning opaque object handles. */
export function replayResolveJson<T>(
  value: unknown,
  variables: Record<string, unknown>,
): ReplayResolutionResult<T> {
  return getRustKernel().replay_resolve_json(value, variables) as ReplayResolutionResult<T>;
}

/** Resolves a legacy string through Rust while retaining JavaScript UTF-16 code units. */
export function replayResolveString(
  value: unknown,
  variables: Record<string, unknown>,
): ReplayResolutionResult<string> {
  return getRustKernel().replay_resolve_string(value, variables) as ReplayResolutionResult<string>;
}

/** Resolves one finite legacy number through Rust and JavaScript numeric intrinsics. */
export function replayResolveNumber(
  value: unknown,
  variables: Record<string, unknown>,
): ReplayResolutionResult<number> {
  return getRustKernel().replay_resolve_number(value, variables) as ReplayResolutionResult<number>;
}

/** Evaluates a legacy condition through the shared resolver while preserving JavaScript intrinsics. */
export function replayEvaluateCondition(
  condition: unknown,
  variables: Record<string, unknown>,
): boolean {
  return getRustKernel().replay_evaluate_condition(condition, variables);
}

/** Maps a V2 action error code to its V3-compatible code. */
export function replayV2ErrorCode(code: string): string {
  return getRustKernel().replay_v2_error_code(code);
}

/** Projects a V3 node policy to the legacy V2 action-policy shape. */
export function replayV2ActionPolicy<T>(policy: unknown): T | undefined {
  return decode<T | undefined>(getRustKernel().replay_v2_action_policy(encode(policy ?? null)));
}

export type ReplayVarsPatchOp =
  | { op: 'set'; name: string; value: unknown }
  | { op: 'delete'; name: string };

/** Computes the complete ordered V3 variable patch after one isolated V2 action run. */
export function replayV2AdapterResultPlan(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ReplayVarsPatchOp[] {
  return decode<ReplayVarsPatchOp[]>(
    getRustKernel().replay_v2_adapter_result_plan(encode(before), encode(after)),
  );
}

/** Plans sequential recorded-DAG mutation while callers retain node config values by identity. */
export function replayRecordedStepAppendPlan(
  previousNodeId: string | undefined,
  edgeCount: number,
  stepId: string,
): RecordedStepAppendPlan {
  return decode(getRustKernel().replay_recorded_step_append_plan(previousNodeId, edgeCount, stepId));
}

/** Rebuilds recording-session node indexes from opaque host node identities. */
export function replayRecordingCachePlan(
  nodes: ReadonlyArray<{ id: string }>,
  edgeSeq: number,
): RecordingCachePlan {
  return decode(getRustKernel().replay_recording_cache_plan(encode(nodes), edgeSeq));
}

/** Plans recording-session upserts and rechaining without serializing caller-owned configs. */
export function replayRecordingAppendPlan(input: {
  nodes: ReadonlyArray<{ id: string }>;
  edges: ReadonlyArray<{ to: string }>;
  cache: ReadonlyArray<readonly [string, number]>;
  edgeSeq: number;
  steps: ReadonlyArray<{ id: string; type: string }>;
}): RecordingAppendPlan {
  return decode(
    getRustKernel().replay_recording_append_plan(
      encode({
        ...input,
        cache: input.cache.map(([id, index]) => [id, index]),
      }),
    ),
  );
}

/** Selects a valid recording node type before the host emits any legacy warning. */
export function replayRecordingNodeTypePlan(stepType: string): RecordingNodeTypePlan {
  return decode(getRustKernel().replay_recording_node_type_plan(stepType));
}

/** Constructs initial recording metadata while the host supplies time and generated IDs. */
export function replayInitialFlowPlan(
  authoredMeta: unknown,
  generatedId: string,
  timestamp: string,
): InitialFlowPlan {
  return decode(getRustKernel().replay_initial_flow_plan(encode(authoredMeta), generatedId, timestamp));
}

/** Selects variable upsert slots while opaque variable objects and native key identity stay host-side. */
export function replayRecordingVariableAppendPlan(
  existingKeys: readonly unknown[],
  incomingKeys: readonly unknown[],
): Array<{ sourceIndex: number; targetIndex: number }> {
  return getRustKernel().replay_recording_variable_append_plan([...existingKeys], [...incomingKeys]);
}
