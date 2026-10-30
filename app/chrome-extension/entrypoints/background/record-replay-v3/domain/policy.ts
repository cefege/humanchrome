import { runPolicy } from 'humanchrome-shared';
import type { EdgeLabel, NodeId } from './ids';
import type { RRErrorCode } from './errors';
import type { UnixMillis } from './json';

export interface TimeoutPolicy {
  ms: UnixMillis;
  /** attempt = per attempt, node = entire node execution. */
  scope?: 'attempt' | 'node';
}

export interface RetryPolicy {
  retries: number;
  intervalMs: UnixMillis;
  backoff?: 'none' | 'exp' | 'linear';
  maxIntervalMs?: UnixMillis;
  jitter?: 'none' | 'full';
  /** Only retry when the error code is one of these. */
  retryOn?: ReadonlyArray<RRErrorCode>;
}

export type OnErrorPolicy =
  | { kind: 'stop' }
  | { kind: 'continue'; as?: 'warning' | 'error' }
  | {
      kind: 'goto';
      target: { kind: 'edgeLabel'; label: EdgeLabel } | { kind: 'node'; nodeId: NodeId };
    }
  | { kind: 'retry'; override?: Partial<RetryPolicy> };

export interface ArtifactPolicy {
  screenshot?: 'never' | 'onFailure' | 'always';
  /** Path template used when saving screenshots. */
  saveScreenshotAs?: string;
  includeConsole?: boolean;
  includeNetwork?: boolean;
}

export interface NodePolicy {
  timeout?: TimeoutPolicy;
  retry?: RetryPolicy;
  onError?: OnErrorPolicy;
  artifacts?: ArtifactPolicy;
}

export interface FlowPolicy {
  defaultNodePolicy?: NodePolicy;
  /** How to handle unsupported node kinds. */
  unsupportedNodePolicy?: OnErrorPolicy;
  /** Overall Run timeout in milliseconds. */
  runTimeoutMs?: UnixMillis;
}

/** Merges flow and node policy through the Rust policy kernel. */
export function mergeNodePolicy(
  flowDefault: NodePolicy | undefined,
  nodePolicy: NodePolicy | undefined,
): NodePolicy {
  return runPolicy.mergeRunNodePolicy(flowDefault, nodePolicy);
}
