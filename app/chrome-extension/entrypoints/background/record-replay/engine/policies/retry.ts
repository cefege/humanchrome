// engine/policies/retry.ts — effect host for Rust-owned retry/backoff policy

import { replayPolicy } from 'humanchrome-shared';

export type BackoffKind = 'none' | 'exp';

export interface RetryOptions {
  count?: number;
  intervalMs?: number;
  backoff?: BackoffKind;
}

export async function withRetry<T>(
  run: () => Promise<T>,
  onRetry?: (attempt: number, err: any) => Promise<void> | void,
  opts?: RetryOptions,
): Promise<T> {
  const max = Math.max(0, Number(opts?.count ?? 0));
  const base = Math.max(0, Number(opts?.intervalMs ?? 0));
  const backoff = (opts?.backoff || 'none') as BackoffKind;
  let attempt = 0;
  while (true) {
    try {
      return await run();
    } catch (error) {
      if (replayPolicy.replayRetryExhausted(attempt, max)) throw error;
      if (onRetry) await onRetry(attempt, error);
      const delay = replayPolicy.replayRetryDelayMs(base, backoff, attempt);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      attempt += 1;
    }
  }
}
