import type { NodeExecutionResult } from '@/entrypoints/background/record-replay-v3/engine/plugins/types';

export type SucceededResult = Extract<NodeExecutionResult, { status: 'succeeded' }>;
export type FailedResult = Extract<NodeExecutionResult, { status: 'failed' }>;

export function asSucceeded(result: NodeExecutionResult): SucceededResult {
  if (result.status !== 'succeeded') {
    throw new Error(`Expected succeeded result but got ${result.status}`);
  }
  return result;
}

export function asFailed(result: NodeExecutionResult): FailedResult {
  if (result.status !== 'failed') {
    throw new Error(`Expected failed result but got ${result.status}`);
  }
  return result;
}
